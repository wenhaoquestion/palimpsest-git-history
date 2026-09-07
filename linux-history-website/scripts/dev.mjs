import { createServer } from 'vite'
import config from '../vite.config.mjs'
import { gitHistoryApi } from '../../server/api-middleware.mjs'
import { createLinuxService } from '../server.mjs'
import { linuxDisplayUrl } from './paths.mjs'

const service = await createLinuxService()
const api = gitHistoryApi({ service, readOnly: true, publicRepository: { name: 'torvalds/linux', displayPath: linuxDisplayUrl }, allowedRefs: ['HEAD', 'all', 'master', 'refs/heads/master'] })
const server = await createServer({ ...config, plugins: [...config.plugins, api] })
await server.listen()
server.printUrls()
