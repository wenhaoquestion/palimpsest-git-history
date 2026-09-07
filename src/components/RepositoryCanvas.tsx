import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'
import type { ChangeKind, CommitLandscape, FileChange, TreeFile } from '../types/git'
import {
  buildRepositoryLayout,
  CHANGE_COLORS,
  ISO_X,
  ISO_Y,
  projectIsometric,
  topLevelOf,
} from '../lib/repository-layout'
import type {
  DirectoryDistrict,
  FileBlock,
  LayoutPoint,
  RepositoryLayout,
} from '../lib/repository-layout'

export interface RepositoryCanvasProps {
  files: TreeFile[]
  changes: FileChange[]
  landscape?: CommitLandscape | null
  selectedPath: string | null
  selectedDirectory: string | null
  onSelectFile: (path: string) => void
  onSelectDirectory: (path: string) => void
  reducedMotion: boolean
  focusMode: 'overview' | 'inspect'
}

interface CanvasSize {
  width: number
  height: number
  dpr: number
}

interface Camera {
  zoom: number
  offsetX: number
  offsetY: number
}

interface CameraTween {
  start: number
  duration: number
  from: Camera
  to: Camera
}

interface DragState {
  pointerId: number
  startX: number
  startY: number
  originX: number
  originY: number
  moved: boolean
}

interface HitRegion {
  kind: 'file' | 'directory' | 'aggregate'
  path: string
  label: string
  meta: string
  status: ChangeKind | null
  polygons: LayoutPoint[][]
}

interface HoverInfo extends HitRegion {
  x: number
  y: number
}

const MIN_ZOOM = 0.14
const MAX_ZOOM = 4.8
const MOTION_DURATION = 420
const RAPID_LAYOUT_WINDOW = 180
const ZOOM_SETTLE_DELAY = 100
// A viewport-sized raster avoids replaying thousands of Canvas commands on
// every pointer frame. Two surfaces (only during a commit dissolve) use at
// most 32 MiB of RGBA pixels, independent of repository size and world zoom.
const MAX_SCENE_PIXELS = 4 * 1024 * 1024
const MAX_SCENE_DIMENSION = 4096
const SCENE_OVERSCAN = 144

interface SceneRaster {
  canvas: HTMLCanvasElement
  camera: Camera
  size: CanvasSize
  viewport: CanvasSize
  layout: RepositoryLayout
  focusMode: RepositoryCanvasProps['focusMode']
  selectedPath: string | null
  selectedDirectory: string | null
  regions: HitRegion[]
}
const FONT_STACK = 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'

const rootStyle: CSSProperties = {
  position: 'relative',
  isolation: 'isolate',
  width: '100%',
  height: '100%',
  minHeight: 360,
  overflow: 'hidden',
  borderRadius: 'inherit',
  background: '#101311',
}

const canvasStyle: CSSProperties = {
  display: 'block',
  width: '100%',
  height: '100%',
  minHeight: 360,
  touchAction: 'none',
  outline: 'none',
}

const legendStyle: CSSProperties = {
  position: 'absolute',
  top: 14,
  right: 14,
  zIndex: 3,
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '7px 10px',
  color: '#c8cbc4',
  background: 'rgba(15, 18, 16, 0.82)',
  border: '1px solid rgba(226, 229, 218, 0.1)',
  borderRadius: 7,
  boxShadow: '0 8px 28px rgba(0, 0, 0, 0.2)',
  backdropFilter: 'blur(8px)',
  pointerEvents: 'none',
  fontFamily: FONT_STACK,
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: '0.04em',
}

const fallbackStyle: CSSProperties = {
  position: 'absolute',
  left: 14,
  bottom: 14,
  zIndex: 4,
  width: 'min(310px, calc(100% - 28px))',
  color: '#daddd5',
  background: 'rgba(15, 18, 16, 0.94)',
  border: '1px solid rgba(226, 229, 218, 0.12)',
  borderRadius: 8,
  boxShadow: '0 12px 36px rgba(0, 0, 0, 0.24)',
  fontFamily: FONT_STACK,
  fontSize: 11,
}

const visuallyHiddenStyle: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
}

const legendItems: Array<{ status: ChangeKind | 'stable'; label: string; color: string }> = [
  { status: 'A', label: 'Added', color: CHANGE_COLORS.A },
  { status: 'M', label: 'Modified', color: CHANGE_COLORS.M },
  { status: 'R', label: 'Renamed', color: CHANGE_COLORS.R },
  { status: 'D', label: 'Deleted', color: CHANGE_COLORS.D },
  { status: 'stable', label: 'Existing', color: '#737b74' },
]

export const RepositoryCanvas = memo(function RepositoryCanvas({
  files,
  changes,
  landscape,
  selectedPath,
  selectedDirectory,
  onSelectFile,
  onSelectDirectory,
  reducedMotion,
  focusMode,
}: RepositoryCanvasProps) {
  const containerRef = useRef<HTMLElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const sizeRef = useRef<CanvasSize>({ width: 0, height: 0, dpr: 1 })
  const cameraRef = useRef<Camera>({ zoom: 1, offsetX: 0, offsetY: 0 })
  const cameraTweenRef = useRef<CameraTween | null>(null)
  const viewInitializedRef = useRef(false)
  const lastFocusModeRef = useRef(focusMode)
  const transitionRef = useRef({ start: 0, duration: 0 })
  const lastTransitionAtRef = useRef(0)
  const frameRef = useRef<number | null>(null)
  const drawRef = useRef<(time: number) => boolean>(() => false)
  const hitRegionsRef = useRef<HitRegion[]>([])
  const hitCameraRef = useRef<Camera>(cameraRef.current)
  const rasterRef = useRef<SceneRaster | null>(null)
  const previousRasterRef = useRef<SceneRaster | null>(null)
  const zoomSettlingRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hoverRef = useRef<HitRegion | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const continuityLayoutRef = useRef<RepositoryLayout | null>(null)
  const [hover, setHover] = useState<HoverInfo | null>(null)

  const layoutOptions = useMemo(() => ({
    maxBlocks: focusMode === 'inspect' ? 620 : 440,
    sourceFileCount: landscape?.totalFiles,
    sourceDirectoryCount: landscape?.totalDirectories,
    sourceTotalBytes: landscape?.totalBytes,
    directorySummaries: landscape?.directories,
  }), [focusMode, landscape])
  const rawLayout = useMemo(
    () => buildRepositoryLayout(files, changes, layoutOptions),
    [files, changes, layoutOptions],
  )
  // Highlighting an existing block changes paint only. Re-sample only when an
  // inspected file is outside the bounded landscape's visible sample.
  const selectedLayout = useMemo(() => {
    if (!selectedPath || rawLayout.blocks.some((block) => block.path === selectedPath)) return rawLayout
    return buildRepositoryLayout(files, changes, { ...layoutOptions, selectedPath })
  }, [rawLayout, files, changes, layoutOptions, selectedPath])
  const layout = useMemo(
    () => stabilizeRepositoryLayout(selectedLayout, continuityLayoutRef.current),
    [selectedLayout],
  )
  const layoutRef = useRef(layout)
  layoutRef.current = layout

  useLayoutEffect(() => {
    continuityLayoutRef.current = layout
  }, [layout])

  const scheduleDraw = useCallback(() => {
    if (frameRef.current !== null || document.hidden) return
    frameRef.current = window.requestAnimationFrame((time) => {
      frameRef.current = null
      if (drawRef.current(time)) scheduleDraw()
    })
  }, [])

  const paint = useCallback(
    (time: number): boolean => {
      const canvas = canvasRef.current
      if (!canvas) return false
      const context = canvas.getContext('2d', { alpha: false })
      const size = sizeRef.current
      if (!context || size.width <= 0 || size.height <= 0) return false
      const activeLayout = layoutRef.current

      const tween = cameraTweenRef.current
      let cameraMoving = false
      if (tween) {
        const progress = clamp01((time - tween.start) / tween.duration)
        const eased = easeOutCubic(progress)
        cameraRef.current = {
          zoom: lerp(tween.from.zoom, tween.to.zoom, eased),
          offsetX: lerp(tween.from.offsetX, tween.to.offsetX, eased),
          offsetY: lerp(tween.from.offsetY, tween.to.offsetY, eased),
        }
        cameraMoving = progress < 1
        if (!cameraMoving) cameraTweenRef.current = null
      }

      const transition = transitionRef.current
      const changeProgress = transition.duration
        ? clamp01((time - transition.start) / transition.duration)
        : 1

      const camera = cameraRef.current
      const hovered = hoverRef.current
      let raster = rasterRef.current
      const sceneChanged = !raster || raster.layout !== activeLayout
        || raster.focusMode !== focusMode || raster.selectedPath !== selectedPath
        || raster.selectedDirectory !== selectedDirectory
        || raster.viewport.width !== size.width || raster.viewport.height !== size.height
        || raster.viewport.dpr !== size.dpr
      const zoomPreview = zoomSettlingRef.current !== null || cameraMoving
      const needsRaster = sceneChanged || !raster
        || (!zoomPreview && (raster.camera.zoom !== camera.zoom || !rasterCoversViewport(raster, camera, size)))

      if (needsRaster) {
        releaseRaster(previousRasterRef.current)
        previousRasterRef.current = null
        const next = createSceneRaster({
          layout: activeLayout,
          size,
          camera,
          focusMode,
          selectedPath,
          selectedDirectory,
          hovered: null,
          // Geometry is rasterized once at its final size. The cached old and
          // new snapshots dissolve below, so motion no longer repaints every
          // directory, facade, label, and hit polygon for 420 ms.
          showEmpty: activeLayout.sourceFileCount === 0,
        })
        if (next) {
          if (raster && raster.layout !== activeLayout && changeProgress < 1 && !reducedMotion) {
            releaseRaster(previousRasterRef.current)
            previousRasterRef.current = raster
          } else {
            releaseRaster(raster)
          }
          rasterRef.current = next
          raster = next
        } else {
          releaseRaster(raster)
          rasterRef.current = null
          raster = null
        }
      }

      context.setTransform(size.dpr, 0, 0, size.dpr, 0, 0)
      context.fillStyle = '#0e100f'
      context.fillRect(0, 0, size.width, size.height)
      if (raster) {
        const previous = previousRasterRef.current
        if (previous && changeProgress < 1) {
          compositeRaster(context, previous, camera)
          context.globalAlpha = easeOutCubic(changeProgress)
        }
        compositeRaster(context, raster, camera)
        context.globalAlpha = 1
        hitRegionsRef.current = raster.regions
        hitCameraRef.current = raster.camera
        drawScaleMark(context, size, camera.zoom, activeLayout)
      } else {
        // If the browser cannot allocate an offscreen surface, keep the view
        // functional using the bounded vector scene on the visible canvas.
        hitRegionsRef.current = paintRepositoryScene(context, {
          layout: activeLayout, size, camera, focusMode, selectedPath,
          selectedDirectory, hovered: null,
          showEmpty: activeLayout.sourceFileCount === 0,
        })
        hitCameraRef.current = { ...camera }
        drawScaleMark(context, size, camera.zoom, activeLayout)
      }
      if (hovered) drawHoverAccent(context, activeLayout, camera, hovered, focusMode, selectedPath, selectedDirectory)
      if (changeProgress >= 1) {
        releaseRaster(previousRasterRef.current)
        previousRasterRef.current = null
      }

      return cameraMoving || (previousRasterRef.current !== null && changeProgress < 1)
    },
    [focusMode, layout, reducedMotion, selectedDirectory, selectedPath],
  )

  drawRef.current = paint

  useLayoutEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return

    const resize = () => {
      const rect = container.getBoundingClientRect()
      const width = Math.max(1, Math.round(rect.width))
      const height = Math.max(1, Math.round(rect.height))
      const nativeDpr = window.devicePixelRatio || 1
      const pixelBudget = width * height > 1_050_000 ? 1.45 : 1.75
      const dpr = Math.min(
        pixelBudget, nativeDpr,
        Math.sqrt(MAX_SCENE_PIXELS / (width * height)),
        MAX_SCENE_DIMENSION / width,
        MAX_SCENE_DIMENSION / height,
      )
      const previous = sizeRef.current
      if (previous.width === width && previous.height === height && previous.dpr === dpr) return
      sizeRef.current = { width, height, dpr }
      canvas.width = Math.max(1, Math.round(width * dpr))
      canvas.height = Math.max(1, Math.round(height * dpr))
      // A resize must not silently reframe a view that the user is navigating.
      // Only establish the initial camera once real repository geometry exists;
      // subsequent layout changes are intentionally camera-neutral.
      if (!viewInitializedRef.current && hasRenderableGeometry(layoutRef.current)) {
        cameraRef.current = fitCamera(layoutRef.current, width, height, focusMode)
        cameraTweenRef.current = null
        viewInitializedRef.current = true
      } else if (previous.width > 0 && previous.height > 0) {
        // Keep the same world point at the viewport center when the window or
        // inspector changes size, preserving the user's pan and zoom.
        cameraRef.current = {
          ...cameraRef.current,
          offsetX: cameraRef.current.offsetX + (width - previous.width) / 2,
          offsetY: cameraRef.current.offsetY + (height - previous.height) / 2,
        }
        cameraTweenRef.current = null
      }
      scheduleDraw()
    }

    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(container)
    return () => observer.disconnect()
  }, [focusMode, scheduleDraw])

  useLayoutEffect(() => {
    const now = performance.now()
    const rapidSequence = now - lastTransitionAtRef.current < RAPID_LAYOUT_WINDOW
    lastTransitionAtRef.current = now
    transitionRef.current = {
      start: now,
      // Rapid steps settle immediately instead of restarting a dissolve.
      // Deliberate step/playback changes keep the brief visual transition.
      duration: reducedMotion || rapidSequence ? 0 : MOTION_DURATION,
    }
    scheduleDraw()
  }, [changes, reducedMotion, scheduleDraw])

  useEffect(() => {
    const size = sizeRef.current
    const now = performance.now()
    const focusModeChanged = lastFocusModeRef.current !== focusMode

    if (focusModeChanged) {
      lastFocusModeRef.current = focusMode
    }

    // Commit data can arrive dozens of times while scrubbing. Never fit/tween
    // the camera for those ordinary layout updates: the spatial frame remains
    // fixed. Reframing is reserved for the first meaningful scene and an
    // explicit Overview/Inspect mode change (Home is handled by resetCamera).
    const shouldEstablishInitialView = !viewInitializedRef.current && hasRenderableGeometry(layout)
    if (size.width > 0 && size.height > 0 && (focusModeChanged || shouldEstablishInitialView)) {
      const target = fitCamera(layout, size.width, size.height, focusMode)
      if (shouldEstablishInitialView || reducedMotion) {
        cameraRef.current = target
        cameraTweenRef.current = null
        viewInitializedRef.current = true
      } else {
        cameraTweenRef.current = {
          start: now,
          duration: 460,
          from: { ...cameraRef.current },
          to: target,
        }
      }
    }
    scheduleDraw()
  }, [focusMode, layout, reducedMotion, scheduleDraw])

  useEffect(() => {
    scheduleDraw()
  }, [scheduleDraw, selectedDirectory, selectedPath])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault()
      if (zoomSettlingRef.current !== null) clearTimeout(zoomSettlingRef.current)
      zoomSettlingRef.current = setTimeout(() => {
        zoomSettlingRef.current = null
        scheduleDraw()
      }, ZOOM_SETTLE_DELAY)
      const rect = canvas.getBoundingClientRect()
      const x = event.clientX - rect.left
      const y = event.clientY - rect.top
      const camera = cameraRef.current
      const factor = Math.exp(-event.deltaY * 0.0014)
      const nextZoom = clamp(camera.zoom * factor, MIN_ZOOM, MAX_ZOOM)
      const ratio = nextZoom / camera.zoom
      cameraRef.current = {
        zoom: nextZoom,
        offsetX: x - (x - camera.offsetX) * ratio,
        offsetY: y - (y - camera.offsetY) * ratio,
      }
      cameraTweenRef.current = null
      scheduleDraw()
    }
    canvas.addEventListener('wheel', handleWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', handleWheel)
  }, [scheduleDraw])

  useEffect(() => {
    const releaseSurfaces = () => {
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current)
      frameRef.current = null
      if (zoomSettlingRef.current !== null) clearTimeout(zoomSettlingRef.current)
      zoomSettlingRef.current = null
      releaseRaster(rasterRef.current)
      releaseRaster(previousRasterRef.current)
      rasterRef.current = null
      previousRasterRef.current = null
      hitRegionsRef.current = []
    }
    const handleVisibility = () => {
      if (document.hidden) releaseSurfaces()
      else scheduleDraw()
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
      releaseSurfaces()
    }
  }, [scheduleDraw])

  const updateHover = useCallback(
    (region: HitRegion | null, x: number, y: number) => {
      const previous = hoverRef.current
      hoverRef.current = region
      const changed = previous?.kind !== region?.kind
        || previous?.path !== region?.path
        || previous?.label !== region?.label
      if (!region) {
        if (hover !== null) setHover(null)
      } else if (changed || !hover || Math.abs(hover.x - x) > 8 || Math.abs(hover.y - y) > 8) {
        setHover({ ...region, x, y })
      }
      const canvas = canvasRef.current
      if (canvas) canvas.style.cursor = region ? 'pointer' : dragRef.current ? 'grabbing' : 'grab'
      if (changed) scheduleDraw()
    },
    [hover, scheduleDraw],
  )

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: cameraRef.current.offsetX,
      originY: cameraRef.current.offsetY,
      moved: false,
    }
    event.currentTarget.style.cursor = 'grabbing'
  }, [])

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const canvas = event.currentTarget
      const rect = canvas.getBoundingClientRect()
      const x = event.clientX - rect.left
      const y = event.clientY - rect.top
      const drag = dragRef.current

      if (drag && drag.pointerId === event.pointerId) {
        const deltaX = event.clientX - drag.startX
        const deltaY = event.clientY - drag.startY
        if (Math.abs(deltaX) + Math.abs(deltaY) > 3) drag.moved = true
        cameraRef.current = {
          ...cameraRef.current,
          offsetX: drag.originX + deltaX,
          offsetY: drag.originY + deltaY,
        }
        cameraTweenRef.current = null
        if (hoverRef.current) updateHover(null, x, y)
        scheduleDraw()
        return
      }

      updateHover(hitTestAtCamera(hitRegionsRef.current, x, y, cameraRef.current, hitCameraRef.current), x, y)
    },
    [scheduleDraw, updateHover],
  )

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      dragRef.current = null
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      const rect = event.currentTarget.getBoundingClientRect()
      const x = event.clientX - rect.left
      const y = event.clientY - rect.top
      const hit = hitTestAtCamera(hitRegionsRef.current, x, y, cameraRef.current, hitCameraRef.current)
      event.currentTarget.style.cursor = hit ? 'pointer' : 'grab'
      if (!drag.moved && hit) {
        if (hit.kind === 'file') onSelectFile(hit.path)
        else onSelectDirectory(hit.path)
      }
      updateHover(hit, x, y)
    },
    [onSelectDirectory, onSelectFile, updateHover],
  )

  const handlePointerLeave = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (!dragRef.current) updateHover(null, 0, 0)
      event.currentTarget.style.cursor = dragRef.current ? 'grabbing' : 'grab'
    },
    [updateHover],
  )

  const resetCamera = useCallback(() => {
    const size = sizeRef.current
    const target = fitCamera(layoutRef.current, size.width, size.height, focusMode)
    viewInitializedRef.current = true
    if (reducedMotion) cameraRef.current = target
    else {
      cameraTweenRef.current = {
        start: performance.now(),
        duration: 420,
        from: { ...cameraRef.current },
        to: target,
      }
    }
    scheduleDraw()
  }, [focusMode, reducedMotion, scheduleDraw])

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLCanvasElement>) => {
      const camera = cameraRef.current
      const distance = event.shiftKey ? 84 : 34
      let handled = true
      if (event.key === 'ArrowLeft') camera.offsetX += distance
      else if (event.key === 'ArrowRight') camera.offsetX -= distance
      else if (event.key === 'ArrowUp') camera.offsetY += distance
      else if (event.key === 'ArrowDown') camera.offsetY -= distance
      else if (event.key === '+' || event.key === '=') zoomFromCenter(1.18, camera, sizeRef.current)
      else if (event.key === '-' || event.key === '_') zoomFromCenter(1 / 1.18, camera, sizeRef.current)
      else if (event.key === '0' || event.key === 'Home') resetCamera()
      else if (event.key === 'Enter' && hoverRef.current) {
        const hit = hoverRef.current
        if (hit.kind === 'file') onSelectFile(hit.path)
        else onSelectDirectory(hit.path)
      } else if (event.key === 'Escape') updateHover(null, 0, 0)
      else handled = false

      if (!handled) return
      event.preventDefault()
      if (event.key !== '0' && event.key !== 'Home' && event.key !== 'Enter' && event.key !== 'Escape') {
        cameraTweenRef.current = null
        scheduleDraw()
      }
    },
    [onSelectDirectory, onSelectFile, resetCamera, scheduleDraw, updateHover],
  )

  const topDirectories = useMemo(
    () => layout.directories.filter((directory) => directory.level === 0).slice(0, 48),
    [layout.directories],
  )
  const fallbackFiles = useMemo(
    () => layout.blocks.filter((block) => !block.aggregate).slice(0, 140),
    [layout.blocks],
  )
  const ariaLabel = `${layout.sourceFileCount.toLocaleString()} files across ${layout.sourceDirectoryCount.toLocaleString()} directories. ${changes.length.toLocaleString()} sampled changes in this commit.`

  return (
    <section
      ref={containerRef}
      className={`repository-canvas repository-canvas--${focusMode}`}
      style={rootStyle}
      aria-label="Repository architectural history visualization"
    >
      <canvas
        ref={canvasRef}
        className="repository-canvas__surface"
        style={canvasStyle}
        role="application"
        tabIndex={0}
        aria-label={ariaLabel}
        aria-describedby="repository-canvas-instructions"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        onKeyDown={handleKeyDown}
      />

      <p id="repository-canvas-instructions" style={visuallyHiddenStyle}>
        Drag to pan, use the mouse wheel or plus and minus keys to zoom, arrow keys to move,
        Home to reset the view, and Enter to inspect the focused structure.
      </p>

      <div className="repository-canvas__legend" style={legendStyle} aria-label="Change legend">
        {legendItems.map((item) => (
          <span key={item.status} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span
              aria-hidden="true"
              style={{
                display: 'grid',
                placeItems: 'center',
                width: 14,
                height: 14,
                border: `1px solid ${withAlpha(item.color, 0.52)}`,
                borderRadius: 2,
                color: lighten(item.color, 0.24),
                background: withAlpha(item.color, item.status === 'stable' ? 0.05 : 0.1),
                fontSize: 7,
                lineHeight: 1,
              }}
            >
              {item.status === 'stable' ? '·' : item.status}
            </span>
            {item.label}
          </span>
        ))}
      </div>

      {hover ? (
        <div
          className="repository-canvas__tooltip"
          role="status"
          style={{
            position: 'absolute',
            zIndex: 5,
            left: clamp(hover.x + 14, 8, Math.max(8, sizeRef.current.width - 238)),
            top: clamp(hover.y + 14, 8, Math.max(8, sizeRef.current.height - 74)),
            width: 224,
            padding: '9px 10px',
            color: '#eceee7',
            background: 'rgba(13, 16, 14, 0.94)',
            border: `1px solid ${hover.status ? withAlpha(CHANGE_COLORS[hover.status], 0.5) : 'rgba(232, 235, 226, 0.15)'}`,
            borderRadius: 6,
            boxShadow: '0 10px 30px rgba(0, 0, 0, 0.28)',
            pointerEvents: 'none',
            fontFamily: FONT_STACK,
          }}
        >
          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 11, fontWeight: 650, whiteSpace: 'nowrap' }}>
            {hover.label}
          </div>
          <div style={{ marginTop: 3, color: '#969d95', fontSize: 10, lineHeight: 1.3 }}>{hover.meta}</div>
        </div>
      ) : null}

      <details className="repository-canvas__fallback" style={fallbackStyle}>
        <summary
          style={{
            padding: '9px 11px',
            color: '#b8beb5',
            cursor: 'pointer',
            fontSize: 10,
            fontWeight: 650,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
          }}
        >
          Browse structures
        </summary>
        <div style={{ maxHeight: 250, overflow: 'auto', padding: '0 8px 9px' }}>
          <div style={{ padding: '8px 5px 5px', color: '#747b74', fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
            Districts
          </div>
          {topDirectories.map((directory) => (
            <button
              key={`directory:${directory.path}`}
              type="button"
              onClick={() => onSelectDirectory(directory.path)}
              style={fallbackButtonStyle(directory.path === selectedDirectory)}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{directory.label}</span>
              <span style={{ color: '#717871', fontVariantNumeric: 'tabular-nums' }}>{directory.fileCount}</span>
            </button>
          ))}
          <div style={{ padding: '11px 5px 5px', color: '#747b74', fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
            Files shown
          </div>
          {fallbackFiles.map((block) => (
            <button
              key={`file:${block.id}`}
              type="button"
              onClick={() => onSelectFile(block.path)}
              style={fallbackButtonStyle(block.path === selectedPath)}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{block.path}</span>
              <span style={{ color: block.status ? CHANGE_COLORS[block.status] : '#717871' }}>
                {block.status ?? formatBytes(block.size)}
              </span>
            </button>
          ))}
          {layout.aggregateCount > 0 ? (
            <div style={{ padding: '8px 5px 2px', color: '#7f867f', lineHeight: 1.45 }}>
              {layout.omittedFileCount.toLocaleString()} additional files are grouped into {layout.aggregateCount.toLocaleString()} archive blocks.
            </div>
          ) : null}
        </div>
      </details>
    </section>
  )
})

RepositoryCanvas.displayName = 'RepositoryCanvas'

export default RepositoryCanvas

interface SceneOptions {
  layout: RepositoryLayout
  size: CanvasSize
  camera: Camera
  focusMode: 'overview' | 'inspect'
  selectedPath: string | null
  selectedDirectory: string | null
  hovered: HitRegion | null
  showEmpty: boolean
}

function paintRepositoryScene(context: CanvasRenderingContext2D, options: SceneOptions): HitRegion[] {
  const { layout, size, camera } = options
  context.fillStyle = '#0e100f'
  context.fillRect(0, 0, size.width, size.height)
  drawBackdrop(context, size)
  drawSurveyGrid(context, layout, camera)

  if (options.showEmpty) {
    drawEmptySurvey(context, size)
    return []
  }

  const hitRegions: HitRegion[] = []
  const orderedDirectories = layout.directories
  const selectedBlock = options.selectedPath
    ? layout.blocks.find((block) => !block.aggregate && block.path === options.selectedPath)
    : undefined
  const focusTopLevel = options.selectedDirectory !== null
    ? topLevelOf(options.selectedDirectory)
    : selectedBlock?.topLevelPath ?? null

  for (const directory of orderedDirectories) {
    if (!isVisible(directory.x, directory.y, directory.width, directory.depth,
      directory.elevation, camera, size)) continue
    const polygon = directoryPolygon(directory, camera)
    const selected = isDirectorySelected(directory.path, options.selectedDirectory)
    const hovered = options.hovered?.kind === 'directory' && options.hovered.path === directory.path
    const muted = focusTopLevel !== null && directory.topLevelPath !== focusTopLevel
    drawDirectoryTerrain(context, directory, camera, { selected, hovered, muted })
    drawDistrictPlots(context, directory, camera, muted)
    hitRegions.push({
      kind: 'directory',
      path: directory.path,
      label: directory.label,
      meta: `${directory.fileCount.toLocaleString()} files · ${formatBytes(directory.totalSize)}`,
      status: null,
      polygons: [polygon],
    })
  }

  drawDistrictRoads(context, layout, camera, focusTopLevel)
  drawTraces(context, layout, camera)

  for (const block of layout.blocks) {
    if (!shouldDrawBlock(block, camera.zoom, options)
      || !isVisible(block.x, block.y, block.width, block.depth,
        block.baseElevation + block.height, camera, size)) continue
    const region = drawFileBlock(context, block, camera, options, focusTopLevel)
    hitRegions.push(region)
  }

  drawDirectoryLabels(context, orderedDirectories, camera, options)
  drawFileLabels(context, layout.blocks, camera, options)
  return hitRegions
}

function createSceneRaster(options: SceneOptions): SceneRaster | null {
  const viewport = options.size
  const padding = Math.min(SCENE_OVERSCAN, Math.round(Math.min(viewport.width, viewport.height) * 0.2))
  const width = viewport.width + padding * 2
  const height = viewport.height + padding * 2
  const dpr = Math.min(
    viewport.dpr,
    Math.sqrt(MAX_SCENE_PIXELS / (width * height)),
    MAX_SCENE_DIMENSION / width,
    MAX_SCENE_DIMENSION / height,
  )
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.floor(width * dpr))
  canvas.height = Math.max(1, Math.floor(height * dpr))
  const context = canvas.getContext('2d', { alpha: false })
  if (!context) {
    canvas.width = canvas.height = 0
    return null
  }
  const camera = {
    zoom: options.camera.zoom,
    offsetX: options.camera.offsetX + padding,
    offsetY: options.camera.offsetY + padding,
  }
  const size = { width, height, dpr }
  context.setTransform(dpr, 0, 0, dpr, 0, 0)
  const regions = paintRepositoryScene(context, { ...options, size, camera })
  return {
    canvas, camera, size, viewport, layout: options.layout,
    focusMode: options.focusMode, selectedPath: options.selectedPath,
    selectedDirectory: options.selectedDirectory, regions,
  }
}

function rasterCoversViewport(raster: SceneRaster, camera: Camera, size: CanvasSize): boolean {
  const x = camera.offsetX - raster.camera.offsetX
  const y = camera.offsetY - raster.camera.offsetY
  return x <= 0 && y <= 0 && x + raster.size.width >= size.width && y + raster.size.height >= size.height
}

function compositeRaster(context: CanvasRenderingContext2D, raster: SceneRaster, camera: Camera): void {
  const ratio = camera.zoom / raster.camera.zoom
  context.drawImage(
    raster.canvas,
    camera.offsetX - raster.camera.offsetX * ratio,
    camera.offsetY - raster.camera.offsetY * ratio,
    raster.size.width * ratio,
    raster.size.height * ratio,
  )
}

function releaseRaster(raster: SceneRaster | null): void {
  // Reset dimensions to promptly release the browser's pixel/GPU backing store.
  if (raster) raster.canvas.width = raster.canvas.height = 0
}

function hitTestAtCamera(regions: HitRegion[], x: number, y: number, camera: Camera, rasterCamera: Camera): HitRegion | null {
  const ratio = rasterCamera.zoom / camera.zoom
  return hitTest(regions,
    (x - camera.offsetX) * ratio + rasterCamera.offsetX,
    (y - camera.offsetY) * ratio + rasterCamera.offsetY,
  )
}

/** Conservative projected bounds; skip geometry wholly outside the viewport. */
function isVisible(
  x: number, y: number, width: number, depth: number, height: number,
  camera: Camera, size: CanvasSize,
): boolean {
  const left = (x - y - depth) * ISO_X * camera.zoom + camera.offsetX
  const right = (x + width - y) * ISO_X * camera.zoom + camera.offsetX
  const top = ((x + y) * ISO_Y - height) * camera.zoom + camera.offsetY
  const bottom = (x + y + width + depth) * ISO_Y * camera.zoom + camera.offsetY
  const margin = 32
  return right >= -margin && left <= size.width + margin
    && bottom >= -margin && top <= size.height + margin
}

function drawBackdrop(context: CanvasRenderingContext2D, size: CanvasSize): void {
  const glow = context.createRadialGradient(
    size.width * 0.52,
    size.height * 0.43,
    0,
    size.width * 0.52,
    size.height * 0.43,
    Math.max(size.width, size.height) * 0.72,
  )
  glow.addColorStop(0, 'rgba(122, 139, 125, 0.055)')
  glow.addColorStop(0.62, 'rgba(20, 24, 21, 0.01)')
  glow.addColorStop(1, 'rgba(4, 6, 5, 0.32)')
  context.fillStyle = glow
  context.fillRect(0, 0, size.width, size.height)
}

function drawSurveyGrid(
  context: CanvasRenderingContext2D,
  layout: RepositoryLayout,
  camera: Camera,
): void {
  const step = 36
  const bounds = layout.bounds
  context.save()
  context.strokeStyle = 'rgba(174, 183, 172, 0.045)'
  context.lineWidth = 1
  const startX = Math.floor(bounds.minX / step) * step
  const startY = Math.floor(bounds.minY / step) * step

  context.beginPath()
  for (let x = startX; x <= bounds.maxX + step; x += step) {
    const from = toScreen(x, bounds.minY - step, 0, camera)
    const to = toScreen(x, bounds.maxY + step, 0, camera)
    context.moveTo(from.x, from.y)
    context.lineTo(to.x, to.y)
  }
  for (let y = startY; y <= bounds.maxY + step; y += step) {
    const from = toScreen(bounds.minX - step, y, 0, camera)
    const to = toScreen(bounds.maxX + step, y, 0, camera)
    context.moveTo(from.x, from.y)
    context.lineTo(to.x, to.y)
  }
  context.stroke()
  context.restore()
}

function drawDirectoryTerrain(
  context: CanvasRenderingContext2D,
  directory: DirectoryDistrict,
  camera: Camera,
  state: { selected: boolean; hovered: boolean; muted: boolean },
): void {
  const top = directoryPolygonAt(directory, directory.elevation, camera)
  const base = directoryPolygonAt(directory, directory.baseElevation, camera)
  const right = [base[1], base[2], top[2], top[1]]
  const front = [base[2], base[3], top[3], top[2]]
  const statusColor = directory.dominantStatus ? CHANGE_COLORS[directory.dominantStatus] : '#8b958b'
  const levelAlpha = directory.level === 0 ? 1 : 0.9

  context.save()
  context.globalAlpha = (state.muted ? 0.72 : 1) * levelAlpha
  context.lineJoin = 'round'

  if (directory.level === 0) {
    context.save()
    context.translate(0, 5 * Math.min(1, camera.zoom))
    context.beginPath()
    tracePolygon(context, base)
    context.fillStyle = 'rgba(0, 0, 0, 0.27)'
    context.fill()
    context.restore()
  }

  context.beginPath()
  tracePolygon(context, right)
  context.fillStyle = directory.level === 0 ? 'rgba(38, 43, 39, 0.76)' : 'rgba(45, 50, 46, 0.68)'
  context.fill()
  context.beginPath()
  tracePolygon(context, front)
  context.fillStyle = directory.level === 0 ? 'rgba(31, 36, 33, 0.9)' : 'rgba(38, 43, 39, 0.78)'
  context.fill()

  if (directory.level === 0 && directory.elevation - directory.baseElevation > 3) {
    context.strokeStyle = 'rgba(181, 190, 180, 0.09)'
    context.lineWidth = 0.55
    for (const amount of [0.36, 0.7]) {
      context.beginPath()
      context.moveTo(lerp(base[1].x, top[1].x, amount), lerp(base[1].y, top[1].y, amount))
      context.lineTo(lerp(base[2].x, top[2].x, amount), lerp(base[2].y, top[2].y, amount))
      context.lineTo(lerp(base[3].x, top[3].x, amount), lerp(base[3].y, top[3].y, amount))
      context.stroke()
    }
  }

  context.beginPath()
  tracePolygon(context, top)
  context.fillStyle = state.selected
    ? 'rgba(116, 138, 120, 0.24)'
    : state.hovered
      ? 'rgba(92, 107, 95, 0.2)'
      : directory.level === 0
        ? 'rgba(63, 72, 65, 0.2)'
        : 'rgba(75, 83, 76, 0.13)'
  context.fill()
  context.strokeStyle = state.selected
    ? 'rgba(224, 229, 216, 0.74)'
    : state.hovered
      ? 'rgba(200, 209, 198, 0.52)'
      : directory.changedFileCount > 0
        ? withAlpha(statusColor, directory.level === 0 ? 0.46 : 0.3)
        : directory.level === 0
          ? 'rgba(174, 183, 173, 0.24)'
          : 'rgba(158, 168, 158, 0.14)'
  context.lineWidth = state.selected ? 1.5 : state.hovered ? 1.15 : 0.75
  context.stroke()

  if (directory.level === 0) {
    const inner = insetPolygon(top, 2.6 * Math.min(1, camera.zoom))
    context.beginPath()
    tracePolygon(context, inner)
    context.strokeStyle = directory.changedFileCount > 0
      ? withAlpha(statusColor, 0.18)
      : 'rgba(191, 199, 189, 0.075)'
    context.lineWidth = 0.7
    context.stroke()
  }
  context.restore()
}

function drawDistrictPlots(
  context: CanvasRenderingContext2D,
  directory: DirectoryDistrict,
  camera: Camera,
  muted: boolean,
): void {
  if (directory.fileCount < 2) return
  const target = Math.min(
    directory.level === 0 ? 46 : 24,
    Math.max(7, Math.round(Math.log2(directory.fileCount + 1) * (directory.level === 0 ? 3.2 : 1.8))),
  )
  const aspect = Math.max(0.35, directory.width / Math.max(1, directory.depth))
  const columns = Math.max(2, Math.ceil(Math.sqrt(target * aspect)))
  const rows = Math.max(2, Math.ceil(target / columns))
  const paddingX = Math.min(directory.width * 0.18, 10)
  const paddingY = Math.min(directory.depth * 0.18, 10)
  const statusColor = directory.dominantStatus ? CHANGE_COLORS[directory.dominantStatus] : '#aab2a8'
  const half = clamp(camera.zoom * 0.75, 0.42, 1.05)

  context.save()
  context.globalAlpha = muted ? 0.62 : 1
  context.fillStyle = withAlpha(statusColor, directory.changedFileCount > 0 ? 0.24 : 0.13)
  context.beginPath()
  for (let index = 0; index < target; index += 1) {
    const column = index % columns
    const row = Math.floor(index / columns)
    const x = directory.x + paddingX + ((column + 0.5) / columns) * Math.max(1, directory.width - paddingX * 2)
    const y = directory.y + paddingY + ((row + 0.5) / rows) * Math.max(1, directory.depth - paddingY * 2)
    const point = toScreen(x, y, directory.elevation + 0.05, camera)
    context.moveTo(point.x, point.y - half)
    context.lineTo(point.x + half * 1.35, point.y)
    context.lineTo(point.x, point.y + half)
    context.lineTo(point.x - half * 1.35, point.y)
    context.closePath()
  }
  context.fill()
  context.restore()
}

function drawDistrictRoads(
  context: CanvasRenderingContext2D,
  layout: RepositoryLayout,
  camera: Camera,
  focusTopLevel: string | null,
): void {
  if (layout.roads.length === 0) return
  context.save()
  context.lineCap = 'round'
  context.lineJoin = 'round'
  for (const road of layout.roads) {
    const from = toScreen(road.from.x, road.from.y, road.fromElevation, camera)
    const to = toScreen(road.to.x, road.to.y, road.toElevation, camera)
    const focused = focusTopLevel !== null && (road.fromPath === focusTopLevel || road.toPath === focusTopLevel)
    const distance = Math.hypot(to.x - from.x, to.y - from.y)
    const bend = Math.min(24, distance * 0.08)
    const traffic = clamp(Math.log2(road.weight + 2) / 13, 0.25, 1)
    const control = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 - bend }

    context.beginPath()
    context.moveTo(from.x, from.y)
    context.quadraticCurveTo(control.x, control.y, to.x, to.y)
    context.strokeStyle = 'rgba(5, 7, 6, 0.62)'
    context.lineWidth = focused ? 4.2 : 3.1
    context.stroke()

    context.beginPath()
    context.moveTo(from.x, from.y)
    context.quadraticCurveTo(control.x, control.y, to.x, to.y)
    context.strokeStyle = focused
      ? `rgba(160, 193, 164, ${0.68 + traffic * 0.2})`
      : `rgba(132, 158, 136, ${0.28 + traffic * 0.24})`
    context.lineWidth = focused ? 1.4 + traffic * 0.4 : 0.7 + traffic * 0.35
    context.stroke()

    if (focused || camera.zoom > 0.32) {
      const radius = focused ? 2.2 : 1.35
      for (const point of [from, to]) {
        context.beginPath()
        context.arc(point.x, point.y, radius, 0, Math.PI * 2)
        context.fillStyle = focused ? '#a3bda5' : 'rgba(149, 168, 150, 0.44)'
        context.fill()
      }
    }
  }
  context.restore()
}

function shouldDrawBlock(block: FileBlock, zoom: number, options: SceneOptions): boolean {
  if (block.path === options.selectedPath || block.path === options.hovered?.path || block.status) return true
  if (zoom < 0.34) return block.lod === 0
  if (zoom < 0.62) return block.lod <= 1
  return true
}

function drawEmptySurvey(context: CanvasRenderingContext2D, size: CanvasSize): void {
  const x = size.width / 2
  const y = size.height / 2 - 12
  context.save()
  context.strokeStyle = 'rgba(182, 193, 181, 0.22)'
  context.lineWidth = 1
  context.beginPath()
  context.moveTo(x - 36, y)
  context.lineTo(x + 36, y)
  context.moveTo(x, y - 20)
  context.lineTo(x, y + 20)
  context.stroke()
  context.fillStyle = '#aeb5ad'
  context.font = `600 11px ${FONT_STACK}`
  context.textAlign = 'center'
  context.letterSpacing = '0.08em'
  context.fillText('NO STRUCTURES SURVEYED', x, y + 44)
  context.fillStyle = '#686f69'
  context.font = `400 10px ${FONT_STACK}`
  context.letterSpacing = '0'
  context.fillText('This point in history contains no visible files.', x, y + 63)
  context.restore()
}

function drawTraces(
  context: CanvasRenderingContext2D,
  layout: RepositoryLayout,
  camera: Camera,
): void {
  if (layout.traces.length === 0) return
  context.save()
  context.lineCap = 'round'
  for (const trace of layout.traces) {
    const from = toScreen(trace.from.x, trace.from.y, 4.2, camera)
    const to = toScreen(trace.to.x, trace.to.y, 4.2, camera)
    const current = to
    const distance = Math.hypot(current.x - from.x, current.y - from.y)
    const lift = Math.min(54, Math.max(13, distance * 0.16))
    const control = {
      x: (from.x + current.x) / 2,
      y: (from.y + current.y) / 2 - lift,
    }
    context.beginPath()
    context.moveTo(from.x, from.y)
    context.quadraticCurveTo(control.x, control.y, current.x, current.y)
    context.strokeStyle = trace.kind === 'move'
      ? withAlpha(CHANGE_COLORS.R, 0.46)
      : withAlpha(CHANGE_COLORS.M, 0.13)
    context.lineWidth = trace.kind === 'move'
      ? Math.min(2.4, 1 + Math.log2(trace.count + 1) * 0.42)
      : Math.min(1.4, 0.7 + Math.log2(trace.count + 1) * 0.22)
    context.setLineDash(trace.kind === 'move' ? [] : [3, 6])
    context.stroke()

    if (trace.kind === 'move') {
      const angle = Math.atan2(current.y - control.y, current.x - control.x)
      const arrowSize = 4.5
      context.beginPath()
      context.moveTo(current.x, current.y)
      context.lineTo(current.x - Math.cos(angle - 0.48) * arrowSize, current.y - Math.sin(angle - 0.48) * arrowSize)
      context.lineTo(current.x - Math.cos(angle + 0.48) * arrowSize, current.y - Math.sin(angle + 0.48) * arrowSize)
      context.closePath()
      context.fillStyle = withAlpha(CHANGE_COLORS.R, 0.7)
      context.fill()
    }
  }
  context.restore()
}

function drawFileBlock(
  context: CanvasRenderingContext2D,
  block: FileBlock,
  camera: Camera,
  options: SceneOptions,
  focusTopLevel: string | null,
): HitRegion {
  const changed = block.status !== null
  const selected = block.path === options.selectedPath && !block.aggregate
  const hovered = options.hovered?.path === block.path && options.hovered?.kind !== 'directory'
  const height = block.ghost ? Math.max(1.6, block.height * 0.72) : block.height
  const topColor = blockColor(block)
  const top = blockPolygon(block, block.baseElevation + height, camera)
  const ground = blockPolygon(block, block.baseElevation, camera)
  const right = [ground[1], ground[2], top[2], top[1]]
  const front = [ground[2], ground[3], top[3], top[2]]
  const focusMuted = focusTopLevel !== null && block.topLevelPath !== focusTopLevel

  context.save()
  context.lineJoin = 'round'
  context.globalAlpha = (block.ghost ? 0.62 : 1) * (focusMuted ? 0.7 : 1)

  if ((selected || hovered) && !block.ghost) {
    drawBlockBeacon(context, ground, block.status ? CHANGE_COLORS[block.status] : '#dfe4d9', selected)
  }

  if (block.ghost) {
    context.setLineDash([3, 3])
    context.strokeStyle = withAlpha(CHANGE_COLORS[block.status ?? 'D'], 0.92)
    context.lineWidth = selected || hovered ? 1.8 : 1.15
    for (const polygon of [right, front, top]) {
      context.beginPath()
      tracePolygon(context, polygon)
      context.stroke()
    }
  } else {
    context.save()
    context.translate(1.5, 3.5)
    context.beginPath()
    tracePolygon(context, ground)
    context.fillStyle = `rgba(0, 0, 0, ${block.aggregate ? 0.18 : 0.25})`
    context.fill()
    context.restore()

    context.beginPath()
    tracePolygon(context, right)
    context.fillStyle = shade(topColor, -0.42)
    context.fill()

    context.beginPath()
    tracePolygon(context, front)
    context.fillStyle = shade(topColor, -0.28)
    context.fill()

    context.beginPath()
    tracePolygon(context, top)
    context.fillStyle = topColor
    context.fill()

    if (block.aggregate) {
      context.save()
      context.beginPath()
      tracePolygon(context, top)
      context.clip()
      context.strokeStyle = 'rgba(236, 238, 230, 0.17)'
      context.lineWidth = 0.8
      const bounds = polygonBounds(top)
      context.beginPath()
      for (let x = bounds.minX - 20; x < bounds.maxX + 20; x += 6) {
        context.moveTo(x, bounds.maxY + 8)
        context.lineTo(x + 28, bounds.minY - 8)
      }
      context.stroke()
      context.restore()
    } else if (camera.zoom > 0.46 && height * camera.zoom > 7) {
      drawFacadeRibs(context, front, topColor)
    }

    context.beginPath()
    tracePolygon(context, top)
    context.strokeStyle = selected
      ? 'rgba(242, 244, 235, 0.98)'
      : hovered
        ? 'rgba(236, 239, 229, 0.78)'
        : changed
          ? withAlpha(topColor, 0.9)
          : 'rgba(230, 233, 224, 0.13)'
    context.lineWidth = selected ? 2 : hovered ? 1.5 : changed ? 1.05 : 0.65
    context.stroke()

    const showStatusGlyph = selected
      || hovered
      || camera.zoom > 1.28
      || (camera.zoom > 0.82 && block.lod === 0)
    if (block.status && showStatusGlyph) {
      drawStatusMarker(context, block, camera, block.status)
    }
  }
  context.restore()

  return {
    kind: block.aggregate ? 'aggregate' : 'file',
    path: block.aggregate ? block.directory : block.path,
    label: block.aggregate ? `${block.aggregateCount.toLocaleString()} grouped files` : block.name,
    meta: block.aggregate
      ? `${block.directory || 'Repository root'} · ${formatBytes(block.size)} · inspect district`
      : `${block.path} · ${block.status ? `${statusLabel(block.status)} · ` : ''}${formatBytes(block.size)}`,
    status: block.status,
    polygons: [top, right, front],
  }
}

/** Hover is an overlay: moving a pointer must never invalidate the scene raster. */
function drawHoverAccent(
  context: CanvasRenderingContext2D,
  layout: RepositoryLayout,
  camera: Camera,
  hovered: HitRegion,
  focusMode: RepositoryCanvasProps['focusMode'],
  selectedPath: string | null,
  selectedDirectory: string | null,
): void {
  if (hovered.kind === 'directory') {
    const directory = layout.directories.find((candidate) => candidate.path === hovered.path)
    if (!directory) return
    context.save()
    context.beginPath()
    tracePolygon(context, directoryPolygon(directory, camera))
    context.strokeStyle = 'rgba(200, 209, 198, 0.62)'
    context.lineWidth = 1.2
    context.stroke()
    context.restore()
    return
  }
  const block = layout.blocks.find((candidate) => hovered.kind === 'aggregate'
    ? candidate.aggregate && candidate.directory === hovered.path
    : !candidate.aggregate && candidate.path === hovered.path)
  if (!block) return
  context.save()
  drawBlockBeacon(context, blockPolygon(block, block.baseElevation, camera), '#dfe4d9', false)
  context.beginPath()
  tracePolygon(context, blockPolygon(block, block.baseElevation + block.height, camera))
  context.strokeStyle = 'rgba(236, 239, 229, 0.88)'
  context.lineWidth = 1.5
  context.stroke()
  context.restore()
  drawFileLabels(context, [block], camera, {
    layout, camera, size: { width: 0, height: 0, dpr: 1 }, focusMode,
    selectedPath, selectedDirectory, hovered: { ...hovered, path: block.path }, showEmpty: false,
  })
}

function drawBlockBeacon(
  context: CanvasRenderingContext2D,
  ground: LayoutPoint[],
  color: string,
  selected: boolean,
): void {
  const bounds = polygonBounds(ground)
  const centerX = (bounds.minX + bounds.maxX) / 2
  const centerY = (bounds.minY + bounds.maxY) / 2
  const radiusX = Math.max(7, (bounds.maxX - bounds.minX) * 0.9)
  const radiusY = Math.max(3.5, (bounds.maxY - bounds.minY) * 0.9)
  context.save()
  context.beginPath()
  context.ellipse(centerX, centerY + 2, radiusX, radiusY, 0, 0, Math.PI * 2)
  context.strokeStyle = withAlpha(color, selected ? 0.72 : 0.42)
  context.lineWidth = selected ? 1.25 : 0.85
  context.setLineDash(selected ? [] : [2, 3])
  context.stroke()
  context.restore()
}

function drawFacadeRibs(
  context: CanvasRenderingContext2D,
  polygon: LayoutPoint[],
  color: string,
): void {
  const upperLeft = polygon[3]
  const upperRight = polygon[2]
  const lowerLeft = polygon[0]
  const lowerRight = polygon[1]
  context.save()
  context.strokeStyle = withAlpha(lighten(color, 0.28), 0.18)
  context.lineWidth = 0.55
  context.beginPath()
  for (const amount of [0.34, 0.67]) {
    context.moveTo(lerp(upperLeft.x, upperRight.x, amount), lerp(upperLeft.y, upperRight.y, amount))
    context.lineTo(lerp(lowerLeft.x, lowerRight.x, amount), lerp(lowerLeft.y, lowerRight.y, amount))
  }
  context.stroke()
  context.restore()
}

function drawStatusMarker(
  context: CanvasRenderingContext2D,
  block: FileBlock,
  camera: Camera,
  status: ChangeKind,
): void {
  const point = toScreen(
    block.x + block.width / 2,
    block.y + block.depth / 2,
    block.baseElevation + block.height + 2.5,
    camera,
  )
  const color = CHANGE_COLORS[status]
  context.save()
  context.fillStyle = 'rgba(9, 11, 10, 0.9)'
  context.strokeStyle = withAlpha(color, 0.78)
  context.lineWidth = 0.8
  roundedRect(context, point.x - 6, point.y - 6, 12, 12, 2)
  context.fill()
  context.stroke()
  context.fillStyle = lighten(color, 0.2)
  context.font = `650 7px ${FONT_STACK}`
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillText(status, point.x, point.y + 0.25)
  context.restore()
}

function drawDirectoryLabels(
  context: CanvasRenderingContext2D,
  directories: DirectoryDistrict[],
  camera: Camera,
  options: SceneOptions,
): void {
  context.save()
  context.textBaseline = 'bottom'
  const occupied: Array<{ x: number; y: number; width: number; height: number }> = []
  const candidates = [...directories].sort((a, b) => {
    const aSelected = isDirectorySelected(a.path, options.selectedDirectory) ? 1 : 0
    const bSelected = isDirectorySelected(b.path, options.selectedDirectory) ? 1 : 0
    return bSelected - aSelected || a.level - b.level || b.fileCount - a.fileCount
  })
  for (const directory of candidates) {
    const selected = isDirectorySelected(directory.path, options.selectedDirectory)
    if (directory.level === 1 && camera.zoom < 0.72 && !selected) continue
    const point = toScreen(directory.x + 4, directory.y + 4, directory.elevation + 0.2, camera)
    const label = directory.level === 0
      ? `${directory.label}  /  ${directory.fileCount.toLocaleString()}`
      : directory.label
    context.font = directory.level === 0
      ? `650 10px ${FONT_STACK}`
      : `550 9px ${FONT_STACK}`
    const renderedLabel = truncateLabel(context, label, directory.level === 0 ? 170 : 100)
    const metrics = context.measureText(renderedLabel)
    const bounds = { x: point.x - 3, y: point.y - 18, width: metrics.width + 6, height: 17 }
    const overlaps = occupied.some((other) => rectanglesOverlap(bounds, other))
    if (overlaps && !selected) continue
    occupied.push(bounds)
    context.fillStyle = selected
      ? '#e4e8df'
      : directory.level === 0
        ? 'rgba(184, 192, 183, 0.72)'
        : 'rgba(156, 165, 157, 0.48)'
    context.fillText(renderedLabel, point.x, point.y - 5)
    if (directory.level === 0) {
      context.beginPath()
      context.moveTo(point.x, point.y - 2)
      context.lineTo(point.x + Math.min(metrics.width, 42), point.y - 2)
      context.strokeStyle = directory.dominantStatus
        ? withAlpha(CHANGE_COLORS[directory.dominantStatus], 0.44)
        : 'rgba(178, 188, 178, 0.26)'
      context.lineWidth = 0.7
      context.stroke()
    }
  }
  context.restore()
}

function drawFileLabels(
  context: CanvasRenderingContext2D,
  blocks: FileBlock[],
  camera: Camera,
  options: SceneOptions,
): void {
  const chosen = new Map<string, FileBlock>()
  const add = (block: FileBlock | undefined) => {
    if (block) chosen.set(block.id, block)
  }
  add(blocks.find((block) => block.path === options.selectedPath && !block.aggregate))
  add(blocks.find((block) => options.hovered?.path === block.path && options.hovered.kind !== 'directory'))

  const changedLimit = camera.zoom > 1.18 ? 30 : 6
  const changed = blocks
    .filter((block) => block.status && !block.aggregate && !block.ghost)
    .sort((a, b) => b.height - a.height || a.lod - b.lod)
    .slice(0, changedLimit)
  for (const block of changed) add(block)

  if (camera.zoom > 0.96) {
    for (const block of blocks.filter((candidate) => candidate.aggregate).slice(0, 24)) add(block)
  }
  if (options.focusMode === 'inspect' && camera.zoom > 1.5) {
    for (const block of blocks.filter((candidate) => candidate.lod === 0 && !candidate.aggregate).slice(0, 22)) add(block)
  }
  const candidates = [...chosen.values()].slice(0, 48)

  context.save()
  context.textAlign = 'center'
  context.textBaseline = 'bottom'
  for (const block of candidates) {
    const point = toScreen(
      block.x + block.width / 2,
      block.y + block.depth / 2,
      block.baseElevation + block.height + 3.4,
      camera,
    )
    const selected = block.path === options.selectedPath && !block.aggregate
    const hovered = options.hovered?.path === block.path
    context.font = `${selected ? 650 : 560} ${selected ? 10.5 : 9.5}px ${FONT_STACK}`
    const label = block.aggregate
      ? `+${block.aggregateCount.toLocaleString()}`
      : block.status
        ? `${block.status}  ${block.name}`
        : block.name
    const truncated = truncateLabel(context, label, selected ? 160 : 108)
    const metrics = context.measureText(truncated)
    const padding = 4
    context.fillStyle = selected || hovered ? 'rgba(11, 14, 12, 0.9)' : 'rgba(13, 16, 14, 0.72)'
    roundedRect(context, point.x - metrics.width / 2 - padding, point.y - 14, metrics.width + padding * 2, 15, 3)
    context.fill()
    context.fillStyle = selected
      ? '#f1f2eb'
      : block.status
        ? lighten(CHANGE_COLORS[block.status], 0.18)
        : '#b4bbb2'
    context.fillText(truncated, point.x, point.y - 2.5)
  }
  context.restore()
}

function drawScaleMark(
  context: CanvasRenderingContext2D,
  size: CanvasSize,
  zoom: number,
  layout: RepositoryLayout,
): void {
  context.save()
  context.fillStyle = 'rgba(143, 151, 143, 0.62)'
  context.font = `550 9px ${FONT_STACK}`
  context.textAlign = 'right'
  context.fillText(`${Math.round(zoom * 100)}%`, size.width - 16, size.height - 17)
  if (layout.omittedFileCount > 0) {
    context.fillStyle = 'rgba(116, 124, 117, 0.58)'
    const volume = layout.sourceTotalBytes === null ? '' : ` · ${formatBytes(layout.sourceTotalBytes)}`
    context.fillText(`${layout.omittedFileCount.toLocaleString()} grouped${volume} · size → height`, size.width - 16, size.height - 32)
  }
  context.restore()
}

function directoryPolygon(directory: DirectoryDistrict, camera: Camera): LayoutPoint[] {
  return directoryPolygonAt(directory, directory.elevation, camera)
}

function directoryPolygonAt(
  directory: DirectoryDistrict,
  elevation: number,
  camera: Camera,
): LayoutPoint[] {
  return [
    toScreen(directory.x, directory.y, elevation, camera),
    toScreen(directory.x + directory.width, directory.y, elevation, camera),
    toScreen(directory.x + directory.width, directory.y + directory.depth, elevation, camera),
    toScreen(directory.x, directory.y + directory.depth, elevation, camera),
  ]
}

function blockPolygon(block: FileBlock, height: number, camera: Camera): LayoutPoint[] {
  return [
    toScreen(block.x, block.y, height, camera),
    toScreen(block.x + block.width, block.y, height, camera),
    toScreen(block.x + block.width, block.y + block.depth, height, camera),
    toScreen(block.x, block.y + block.depth, height, camera),
  ]
}

function toScreen(x: number, y: number, z: number, camera: Camera): LayoutPoint {
  return {
    x: (x - y) * ISO_X * camera.zoom + camera.offsetX,
    y: ((x + y) * ISO_Y - z) * camera.zoom + camera.offsetY,
  }
}

function hasRenderableGeometry(layout: RepositoryLayout): boolean {
  return layout.sourceFileCount > 0 || layout.blocks.length > 0 || layout.directories.length > 0
}

/**
 * Preserve the repository's mental map between commits. The layout algorithm
 * is deterministic for one snapshot, but a sampled file entering or leaving a
 * district can otherwise repack every district after it. Re-anchor shared
 * top-level districts to their previous centers, then softly retain positions
 * for file blocks that exist in both snapshots. Work stays linear in the
 * bounded visualization payload.
 */
function stabilizeRepositoryLayout(
  next: RepositoryLayout,
  previous: RepositoryLayout | null,
): RepositoryLayout {
  if (!previous || !hasRenderableGeometry(previous) || !hasRenderableGeometry(next)) return next

  const previousDistricts = new Map(
    previous.directories
      .filter((directory) => directory.level === 0)
      .map((directory) => [directory.path, directory] as const),
  )
  const offsets = new Map<string, LayoutPoint>()
  for (const directory of next.directories) {
    if (directory.level !== 0) continue
    const anchor = previousDistricts.get(directory.path)
    if (!anchor) continue
    offsets.set(directory.path, {
      x: anchor.x + anchor.width / 2 - (directory.x + directory.width / 2),
      y: anchor.y + anchor.depth / 2 - (directory.y + directory.depth / 2),
    })
  }
  if (offsets.size === 0) return next

  const offsetFor = (topLevelPath: string): LayoutPoint => offsets.get(topLevelPath) ?? ZERO_POINT
  const directories = next.directories.map((directory) => {
    const offset = offsetFor(directory.topLevelPath)
    return offset === ZERO_POINT
      ? directory
      : { ...directory, x: directory.x + offset.x, y: directory.y + offset.y }
  })

  const previousBlocks = new Map(previous.blocks.map((block) => [block.id, block] as const))
  const blocks = next.blocks.map((block) => {
    const offset = offsetFor(block.topLevelPath)
    const translatedX = block.x + offset.x
    const translatedY = block.y + offset.y
    const anchor = previousBlocks.get(block.id)
    if (!anchor || anchor.topLevelPath !== block.topLevelPath) {
      return offset === ZERO_POINT ? block : { ...block, x: translatedX, y: translatedY }
    }
    // Most of the old position is retained, avoiding slot-to-slot jumps while
    // still allowing the local packing to settle gradually as a district grows.
    return {
      ...block,
      x: lerp(anchor.x, translatedX, 0.2),
      y: lerp(anchor.y, translatedY, 0.2),
    }
  })

  const roads = next.roads.map((road) => {
    const fromOffset = offsetFor(topLevelOf(road.fromPath))
    const toOffset = offsetFor(topLevelOf(road.toPath))
    return {
      ...road,
      from: { x: road.from.x + fromOffset.x, y: road.from.y + fromOffset.y },
      to: { x: road.to.x + toOffset.x, y: road.to.y + toOffset.y },
    }
  })
  const traces = next.traces.map((trace) => {
    const fromOffset = offsetFor(topLevelOf(trace.fromDirectory))
    const toOffset = offsetFor(topLevelOf(trace.toDirectory))
    return {
      ...trace,
      from: { x: trace.from.x + fromOffset.x, y: trace.from.y + fromOffset.y },
      to: { x: trace.to.x + toOffset.x, y: trace.to.y + toOffset.y },
    }
  })
  const stabilizedBounds = boundsForStabilizedLayout(directories, blocks)

  return {
    ...next,
    blocks,
    directories,
    roads,
    traces,
    bounds: stabilizedBounds.bounds,
    projectedBounds: stabilizedBounds.projectedBounds,
  }
}

const ZERO_POINT: LayoutPoint = { x: 0, y: 0 }

function boundsForStabilizedLayout(
  directories: DirectoryDistrict[],
  blocks: FileBlock[],
): { bounds: RepositoryLayout['bounds']; projectedBounds: RepositoryLayout['projectedBounds'] } {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let maximumElevation = 0

  for (const directory of directories) {
    minX = Math.min(minX, directory.x)
    minY = Math.min(minY, directory.y)
    maxX = Math.max(maxX, directory.x + directory.width)
    maxY = Math.max(maxY, directory.y + directory.depth)
    maximumElevation = Math.max(maximumElevation, directory.elevation)
  }
  for (const block of blocks) {
    minX = Math.min(minX, block.x)
    minY = Math.min(minY, block.y)
    maxX = Math.max(maxX, block.x + block.width)
    maxY = Math.max(maxY, block.y + block.depth)
    maximumElevation = Math.max(maximumElevation, block.baseElevation + block.height)
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return {
      bounds: { minX: -12, minY: -12, maxX: 140, maxY: 110 },
      projectedBounds: { minX: -110, minY: -48, maxX: 140, maxY: 140 },
    }
  }

  const margin = 12
  const bounds = {
    minX: minX - margin,
    minY: minY - margin,
    maxX: maxX + margin,
    maxY: maxY + margin,
  }
  const elevated = maximumElevation + 24
  const corners = [
    projectIsometric(bounds.minX, bounds.minY, 0),
    projectIsometric(bounds.maxX, bounds.minY, 0),
    projectIsometric(bounds.maxX, bounds.maxY, 0),
    projectIsometric(bounds.minX, bounds.maxY, 0),
    projectIsometric(bounds.minX, bounds.minY, elevated),
    projectIsometric(bounds.maxX, bounds.minY, elevated),
    projectIsometric(bounds.maxX, bounds.maxY, elevated),
    projectIsometric(bounds.minX, bounds.maxY, elevated),
  ]
  return {
    bounds,
    projectedBounds: {
      minX: Math.min(...corners.map((point) => point.x)),
      minY: Math.min(...corners.map((point) => point.y)),
      maxX: Math.max(...corners.map((point) => point.x)),
      maxY: Math.max(...corners.map((point) => point.y)),
    },
  }
}

function fitCamera(
  layout: RepositoryLayout,
  width: number,
  height: number,
  focusMode: 'overview' | 'inspect',
): Camera {
  const bounds = layout.projectedBounds
  const projectedWidth = Math.max(1, bounds.maxX - bounds.minX)
  const projectedHeight = Math.max(1, bounds.maxY - bounds.minY)
  const horizontalPadding = width < 620 ? 24 : focusMode === 'inspect' ? 24 : 38
  const verticalPadding = width < 620 ? 56 : focusMode === 'inspect' ? 30 : 44
  const fitZoom = Math.min(
    (width - horizontalPadding * 2) / projectedWidth,
    (height - verticalPadding * 2) / projectedHeight,
  )
  const maximum = focusMode === 'inspect' ? 2.45 : 1.72
  const zoom = clamp(fitZoom, MIN_ZOOM, maximum)
  return {
    zoom,
    offsetX: width / 2 - ((bounds.minX + bounds.maxX) / 2) * zoom,
    offsetY: height / 2 - ((bounds.minY + bounds.maxY) / 2) * zoom + 8,
  }
}

function zoomFromCenter(factor: number, camera: Camera, size: CanvasSize): void {
  const x = size.width / 2
  const y = size.height / 2
  const zoom = clamp(camera.zoom * factor, MIN_ZOOM, MAX_ZOOM)
  const ratio = zoom / camera.zoom
  camera.offsetX = x - (x - camera.offsetX) * ratio
  camera.offsetY = y - (y - camera.offsetY) * ratio
  camera.zoom = zoom
}

function hitTest(regions: HitRegion[], x: number, y: number): HitRegion | null {
  for (let index = regions.length - 1; index >= 0; index -= 1) {
    const region = regions[index]
    if (region.polygons.some((polygon) => pointInPolygon(x, y, polygon))) return region
  }
  return null
}

function pointInPolygon(x: number, y: number, polygon: LayoutPoint[]): boolean {
  let inside = false
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const currentPoint = polygon[index]
    const previousPoint = polygon[previous]
    const intersects = currentPoint.y > y !== previousPoint.y > y
      && x < ((previousPoint.x - currentPoint.x) * (y - currentPoint.y))
        / (previousPoint.y - currentPoint.y || Number.EPSILON) + currentPoint.x
    if (intersects) inside = !inside
  }
  return inside
}

function tracePolygon(context: CanvasRenderingContext2D, polygon: LayoutPoint[]): void {
  if (polygon.length === 0) return
  context.moveTo(polygon[0].x, polygon[0].y)
  for (let index = 1; index < polygon.length; index += 1) {
    context.lineTo(polygon[index].x, polygon[index].y)
  }
  context.closePath()
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  context.beginPath()
  context.roundRect(x, y, width, height, radius)
}

function blockColor(block: FileBlock): string {
  if (block.status) return CHANGE_COLORS[block.status]
  if (block.path.includes('/test') || block.path.includes('.test.') || block.path.includes('.spec.')) return '#8a878e'
  if (['c', 'h', 'cc', 'cpp', 'rs', 'go', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'py', 'java'].includes(block.extension)) return '#a09f96'
  if (['css', 'scss', 'sass', 'less', 'html', 'vue', 'svelte'].includes(block.extension)) return '#87978b'
  if (['md', 'mdx', 'txt', 'rst', 'adoc'].includes(block.extension)) return '#9a9482'
  if (['json', 'yaml', 'yml', 'toml', 'ini', 'env', 'xml'].includes(block.extension)) return '#8d898f'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'avif'].includes(block.extension)) return '#967d80'
  if (['woff', 'woff2', 'ttf', 'otf', 'mp3', 'mp4', 'wav', 'mov'].includes(block.extension)) return '#898276'
  return block.aggregate ? '#6f7c72' : '#8e948c'
}

function statusLabel(status: ChangeKind): string {
  if (status === 'A') return 'Added'
  if (status === 'M') return 'Modified'
  if (status === 'D') return 'Deleted'
  if (status === 'R') return 'Renamed or moved'
  if (status === 'C') return 'Copied'
  if (status === 'T') return 'Type changed'
  return 'Unmerged'
}

function isDirectorySelected(path: string, selected: string | null): boolean {
  if (selected === null) return false
  const normalizedSelected = selected.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '')
  const normalizedPath = path.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '')
  return normalizedSelected === normalizedPath
}

function fallbackButtonStyle(selected: boolean): CSSProperties {
  return {
    width: '100%',
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: 10,
    padding: '6px 7px',
    color: selected ? '#eef1e8' : '#adb3aa',
    background: selected ? 'rgba(157, 176, 159, 0.12)' : 'transparent',
    border: 0,
    borderRadius: 4,
    cursor: 'pointer',
    textAlign: 'left',
    fontSize: 10,
  }
}

function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return 'size unknown'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

function truncateLabel(context: CanvasRenderingContext2D, value: string, maximumWidth: number): string {
  if (context.measureText(value).width <= maximumWidth) return value
  let low = 1
  let high = value.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (context.measureText(`${value.slice(0, middle)}…`).width <= maximumWidth) low = middle
    else high = middle - 1
  }
  return `${value.slice(0, low)}…`
}

function polygonBounds(polygon: LayoutPoint[]): { minX: number; minY: number; maxX: number; maxY: number } {
  return {
    minX: Math.min(...polygon.map((point) => point.x)),
    minY: Math.min(...polygon.map((point) => point.y)),
    maxX: Math.max(...polygon.map((point) => point.x)),
    maxY: Math.max(...polygon.map((point) => point.y)),
  }
}

function insetPolygon(polygon: LayoutPoint[], amount: number): LayoutPoint[] {
  const center = polygon.reduce(
    (result, point) => ({ x: result.x + point.x / polygon.length, y: result.y + point.y / polygon.length }),
    { x: 0, y: 0 },
  )
  return polygon.map((point) => {
    const distance = Math.hypot(point.x - center.x, point.y - center.y)
    const ratio = distance > 0 ? Math.max(0, (distance - amount) / distance) : 1
    return {
      x: center.x + (point.x - center.x) * ratio,
      y: center.y + (point.y - center.y) * ratio,
    }
  })
}

function rectanglesOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

function shade(color: string, amount: number): string {
  const rgb = parseHex(color)
  if (!rgb) return color
  const factor = amount < 0 ? 1 + amount : 1
  return `rgb(${Math.round(rgb.r * factor)}, ${Math.round(rgb.g * factor)}, ${Math.round(rgb.b * factor)})`
}

function lighten(color: string, amount: number): string {
  const rgb = parseHex(color)
  if (!rgb) return color
  return `rgb(${Math.round(lerp(rgb.r, 255, amount))}, ${Math.round(lerp(rgb.g, 255, amount))}, ${Math.round(lerp(rgb.b, 255, amount))})`
}

function withAlpha(color: string, alpha: number): string {
  const rgb = parseHex(color)
  if (!rgb) return color
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`
}

function parseHex(color: string): { r: number; g: number; b: number } | null {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(color)
  if (!match) return null
  return {
    r: Number.parseInt(match[1], 16),
    g: Number.parseInt(match[2], 16),
    b: Number.parseInt(match[3], 16),
  }
}

function easeOutCubic(value: number): number {
  return 1 - (1 - value) ** 3
}

function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * amount
}

function clamp01(value: number): number {
  return clamp(value, 0, 1)
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}
