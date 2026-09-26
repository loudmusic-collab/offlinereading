// Netlify Function (v2 API): GET /api/fetch?url=<encoded URL>
import { handleProxy } from '../../server/proxy.js';

export default (request) => handleProxy(request);

export const config = { path: '/api/fetch' };
