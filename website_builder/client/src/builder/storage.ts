import type { ProjectData } from 'grapesjs'

export type Site = { id: string; name: string; theme: string; updated: number; data: ProjectData; importReport?:{warnings:string[];notices:{path:string;text:string}[];pages:string[]} }
const database = () => new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open('lumen-websites', 1)
  request.onupgradeneeded = () => request.result.createObjectStore('sites', { keyPath: 'id' })
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(new Error('Website storage is unavailable. Please allow browser storage.'))
})
async function operation<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('sites', mode), request = action(tx.objectStore('sites'))
    tx.oncomplete = () => { db.close(); resolve(request.result) }
    tx.onerror = tx.onabort = () => { db.close(); reject(new Error('Could not save your website. Export a backup before closing.')) }
  })
}
export const sites = {
  list: async () => (await operation('readonly', s => s.getAll()) as Site[]).sort((a,b) => b.updated-a.updated),
  save: (site: Site) => operation('readwrite', s => s.put(site)),
  remove: (id: string) => operation('readwrite', s => s.delete(id)),
}
