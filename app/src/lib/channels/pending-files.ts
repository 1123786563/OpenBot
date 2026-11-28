function pendingFiles<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("openbot-conversation-start-files", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("files");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const transaction = db.transaction("files", mode);
      const request = operation(transaction.objectStore("files"));
      transaction.oncomplete = () => {
        db.close();
        resolve(request.result);
      };
      transaction.onabort = () => {
        db.close();
        reject(transaction.error);
      };
    };
  });
}

export function savePendingFile(key: string, file: File) {
  return pendingFiles("readwrite", (store) => store.put(file, key));
}

export async function readPendingFile(key: string) {
  const file: unknown = await pendingFiles("readonly", (store) =>
    store.get(key),
  );
  if (!(file instanceof File)) {
    throw new Error("The saved attachment is unavailable in this browser.");
  }
  return file;
}

export function deletePendingFile(key: string) {
  return pendingFiles("readwrite", (store) => store.delete(key));
}
