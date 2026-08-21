export const MAX_FOLDER_FILES = 128
export const MAX_FOLDER_FILE_BYTES = 8 * 1024 * 1024
export const MAX_FOLDER_BYTES = 32 * 1024 * 1024

/** Convert files returned by a webkitdirectory input into the installer payload. */
export async function readSelectedFolderFiles(files) {
  const uploads = []
  let total = 0
  for (const file of files) {
    const path = typeof file.webkitRelativePath === 'string' && file.webkitRelativePath !== ''
      ? file.webkitRelativePath
      : file.name
    if (file.size > MAX_FOLDER_FILE_BYTES) throw new Error(`技能文件过大：${path}`)
    total += file.size
    if (total > MAX_FOLDER_BYTES) throw new Error('技能文件夹总大小超过 32MB')
    if (uploads.length >= MAX_FOLDER_FILES) throw new Error(`技能文件数量超过 ${String(MAX_FOLDER_FILES)}`)
    uploads.push({ path, data: bytesToBase64(new Uint8Array(await file.arrayBuffer())) })
  }
  return uploads
}

function bytesToBase64(data) {
  let binary = ''
  for (let offset = 0; offset < data.length; offset += 0x8000) binary += String.fromCharCode(...data.subarray(offset, offset + 0x8000))
  return btoa(binary)
}
