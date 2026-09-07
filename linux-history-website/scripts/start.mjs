import { createLinuxWebsite } from '../server.mjs'

const host = process.env.HOST || '127.0.0.1'
const port = Number(process.env.PORT || 4180)
let server
try {
  server = await createLinuxWebsite()
  server.listen(port, host, () => console.log(`Linux History: http://${host}:${port} (fixed repository; read-only)`))
  const stop = async () => {
    server.close()
    server.closeAllConnections()
    await server.dispose()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  console.error('Prepare data first with npm run prepare:data, or set LINUX_REPO to a prepared Linux bare repository.')
  process.exitCode = 1
}
