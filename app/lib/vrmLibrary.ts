export type StoredVrmRecord = {
  file: Blob
  id: string
  name: string
  updatedAt: number
}

export type StoredVrmMeta = Omit<StoredVrmRecord, 'file'>

const DB_NAME = 'psfn-vrm'
const DB_VERSION = 1
const STORE_NAME = 'vrm-library'

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION)

    request.addEventListener('upgradeneeded', () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'id' })
      }
    })

    request.addEventListener('success', () => resolve(request.result))
    request.addEventListener('error', () => reject(request.error ?? new Error('IndexedDB open failed.')))
  })
}

function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore, resolve: (value: T) => void, reject: (reason?: unknown) => void) => void,
): Promise<T> {
  return new Promise(async (resolve, reject) => {
    try {
      const database = await openDatabase()
      const transaction = database.transaction(STORE_NAME, mode)
      const store = transaction.objectStore(STORE_NAME)
      transaction.addEventListener('complete', () => database.close())
      transaction.addEventListener('abort', () => {
        database.close()
        reject(transaction.error ?? new Error('IndexedDB transaction aborted.'))
      })
      transaction.addEventListener('error', () => {
        database.close()
        reject(transaction.error ?? new Error('IndexedDB transaction failed.'))
      })
      run(store, resolve, reject)
    } catch (error) {
      reject(error)
    }
  })
}

export async function listStoredVrms(): Promise<StoredVrmMeta[]> {
  return withStore('readonly', (store, resolve, reject) => {
    const request = store.getAll()
    request.addEventListener('success', () => {
      const records = (request.result as StoredVrmRecord[])
        .map(({ file: _file, ...meta }) => meta)
        .sort((left, right) => left.name.localeCompare(right.name))
      resolve(records)
    })
    request.addEventListener('error', () => reject(request.error ?? new Error('Failed to list VRMs.')))
  })
}

export async function getStoredVrm(id: string): Promise<StoredVrmRecord | null> {
  return withStore('readonly', (store, resolve, reject) => {
    const request = store.get(id)
    request.addEventListener('success', () => resolve((request.result as StoredVrmRecord | undefined) ?? null))
    request.addEventListener('error', () => reject(request.error ?? new Error('Failed to load VRM.')))
  })
}

export async function saveStoredVrm(record: StoredVrmRecord): Promise<void> {
  return withStore('readwrite', (store, resolve, reject) => {
    const request = store.put(record)
    request.addEventListener('success', () => resolve())
    request.addEventListener('error', () => reject(request.error ?? new Error('Failed to save VRM.')))
  })
}
