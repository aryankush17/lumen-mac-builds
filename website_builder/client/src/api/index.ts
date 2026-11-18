import axios from 'axios'

/**
 * API client for the Lumen backend.
 * Just two endpoints — audit and blueprint.
 */

axios.defaults.timeout = 20000

export const auditApi = {
  /** Run an audit on one or more URLs (single string or array). */
  run: async (url: string | string[], categories: string[] = []) => {
    const res = await axios.post('/api/audit', { url, categories }, { timeout: 90000 })
    return res.data
  },
  /** List past audits. */
  list: async () => {
    const res = await axios.get('/api/audit')
    return res.data
  },
  /** Fetch a single audit by id. */
  get: async (id: string) => {
    const res = await axios.get(`/api/audit/${id}`)
    return res.data
  }
}

export const blueprintApi = {
  /** Generate a blueprint from form input. */
  generate: async (input: Record<string, unknown>) => {
    const res = await axios.post('/api/blueprint', input, { timeout: 30000 })
    return res.data
  },
  /** List past blueprints. */
  list: async () => {
    const res = await axios.get('/api/blueprint')
    return res.data
  },
  /** Fetch a single blueprint by id. */
  get: async (id: string) => {
    const res = await axios.get(`/api/blueprint/${id}`)
    return res.data
  },
  /** List available niches (for the form dropdown / examples). */
  listNiches: async () => {
    const res = await axios.get('/api/blueprint/niches')
    return res.data
  }
}
