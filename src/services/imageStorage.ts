import { randomUUID } from 'node:crypto';
import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import { env } from '../config/env';
import type { UploadedImage } from '../middleware/upload';
import { errors } from '../utils/AppError';
import { logger } from '../utils/logger';

/**
 * Photos live in Azure Blob Storage, in a container whose files anyone can
 * read by their address (the app shows them directly). Each upload gets a
 * new random name, so a photo's address never changes and phones can cache
 * it for a year. Products (step 9) use the same functions.
 */

export type ImageFolder = 'initiatives' | 'products';

let container: ContainerClient | undefined;

function containerClient(): ContainerClient | null {
  if (!env.AZURE_STORAGE_CONNECTION_STRING) return null;
  container ??= BlobServiceClient.fromConnectionString(
    env.AZURE_STORAGE_CONNECTION_STRING,
  ).getContainerClient(env.AZURE_STORAGE_CONTAINER);
  return container;
}

/** False until the Azure settings are added; uploads then answer 503. */
export function imageStorageReady(): boolean {
  return Boolean(env.AZURE_STORAGE_CONNECTION_STRING);
}

/** Saves a checked photo and returns its public address. */
export async function saveImage(image: UploadedImage, folder: ImageFolder): Promise<string> {
  const client = containerClient();
  if (!client) {
    throw errors.unavailable('Photo uploads are not set up yet. Please try again later.');
  }
  const blob = client.getBlockBlobClient(`${folder}/${randomUUID()}.${image.extension}`);
  try {
    await blob.uploadData(image.buffer, {
      blobHTTPHeaders: {
        blobContentType: image.mimeType,
        blobCacheControl: 'public, max-age=31536000, immutable',
      },
    });
  } catch (error) {
    logger.error({ err: error }, 'Photo upload to Azure failed');
    throw errors.unavailable("We couldn't save the photo right now. Please try again in a minute.");
  }
  return blob.url;
}

/**
 * Removes a photo that is no longer used. Only addresses inside our own
 * container are touched. A failure is logged, not shown: the new photo is
 * already saved, and a leftover file does no harm.
 */
export async function deleteImage(url: string | null | undefined): Promise<void> {
  const client = containerClient();
  if (!client || !url) return;
  const prefix = `${client.url}/`;
  if (!url.startsWith(prefix)) return;
  try {
    await client.getBlockBlobClient(decodeURIComponent(url.slice(prefix.length))).deleteIfExists();
  } catch (error) {
    logger.warn({ err: error }, 'Could not delete an old photo from Azure');
  }
}
