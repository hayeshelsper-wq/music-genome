// Cloud Storage helper for uploaded audio. Audio bytes live in GCS; the paired
// analysis/caption lives in Firestore (see store.ts). Uses Application Default
// Credentials (the Cloud Run service account); bucket from UPLOADS_BUCKET or
// derived from the project id.

import { Storage, type File as GcsFile } from "@google-cloud/storage";

let storage: Storage | null = null;
function getStorage(): Storage {
  if (!storage) storage = new Storage();
  return storage;
}

const BUCKET =
  process.env.UPLOADS_BUCKET ||
  (process.env.GOOGLE_CLOUD_PROJECT
    ? `${process.env.GOOGLE_CLOUD_PROJECT}-uploads`
    : "");

export function uploadsConfigured(): boolean {
  return !!BUCKET;
}

export async function uploadAudio(
  objectPath: string,
  data: Buffer,
  contentType: string
): Promise<void> {
  await getStorage()
    .bucket(BUCKET)
    .file(objectPath)
    .save(data, { contentType, resumable: false });
}

export function audioObject(objectPath: string): GcsFile {
  return getStorage().bucket(BUCKET).file(objectPath);
}

export async function deleteAudio(objectPath: string): Promise<void> {
  await getStorage()
    .bucket(BUCKET)
    .file(objectPath)
    .delete({ ignoreNotFound: true });
}

/** Download a stored object's bytes (studio attempts, extractions, hums). */
export async function readAudio(objectPath: string): Promise<Buffer> {
  const [data] = await getStorage().bucket(BUCKET).file(objectPath).download();
  return data;
}

/** App-proxied playback URL for a stored object — keeps audio behind the auth
 *  gate (no public bucket, no signed-URL expiry headaches). Served by
 *  /api/blob/audio, which only allows a fixed set of prefixes. */
export function signedOrProxyUrl(objectPath: string): string {
  return `/api/blob/audio?path=${encodeURIComponent(objectPath)}`;
}
