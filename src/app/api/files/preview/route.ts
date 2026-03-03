/**
 * File Preview API
 * Serves local files or MinIO files for preview (HTML only for security)
 */

import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { Client as MinioClient } from 'minio';

export const dynamic = 'force-dynamic';

function getMinioClient() {
  const rawEndpoint = process.env.MINIO_PRIVATE_ENDPOINT || process.env.MINIO_PUBLIC_ENDPOINT || '';
  if (!rawEndpoint) return null;
  const accessKey = process.env.MINIO_ACCESS_KEY;
  const secretKey = process.env.MINIO_SECRET_KEY;
  if (!accessKey || !secretKey) return null;

  try {
    const url = new URL(rawEndpoint);
    const useSSLEnv = process.env.MINIO_USE_SSL;
    const useSSL = useSSLEnv !== undefined ? useSSLEnv === 'true' : url.protocol === 'https:';
    const defaultPort = useSSL ? 443 : 9000;
    const port = url.port ? Number(url.port) : defaultPort;
    return new MinioClient({
      endPoint: url.hostname,
      port,
      useSSL,
      accessKey,
      secretKey,
      region: process.env.MINIO_REGION || 'us-east-1',
    });
  } catch (e) {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const filePath = request.nextUrl.searchParams.get('path');

  if (!filePath) {
    return NextResponse.json({ error: 'path is required' }, { status: 400 });
  }

  // Only allow HTML files
  if (!filePath.endsWith('.html') && !filePath.endsWith('.htm')) {
    return NextResponse.json({ error: 'Only HTML files can be previewed' }, { status: 400 });
  }

  // Expand tilde and normalize
  const expandedPath = filePath.replace(/^~/, process.env.HOME || '');
  const normalizedPath = path.normalize(expandedPath);

  let objectKey: string | null = null;
  const match = normalizedPath.match(/projects\/(.*)$/);
  if (match) {
    objectKey = `projects/${match[1].replace(/\\/g, '/')}`;
  }

  const minioClient = getMinioClient();
  const bucket = process.env.MINIO_BUCKET || 'mission-files';

  if (minioClient && objectKey) {
    try {
      const dataStream = await minioClient.getObject(bucket, objectKey);
      const chunks: Buffer[] = [];
      for await (const chunk of dataStream) {
        chunks.push(chunk as Buffer);
      }
      const content = Buffer.concat(chunks);
      return new NextResponse(content, {
        headers: {
          'Content-Type': 'text/html',
        },
      });
    } catch (err: any) {
      if (err.code !== 'NotFound' && err.code !== 'NoSuchKey') {
         console.error('[MINIO PREVIEW] Error:', err);
      }
      // If error occurs, fallback to local path validation 
    }
  }

  // Security check - only allow paths from environment config
  const allowedPaths = [
    process.env.WORKSPACE_BASE_PATH?.replace(/^~/, process.env.HOME || ''),
    process.env.PROJECTS_PATH?.replace(/^~/, process.env.HOME || ''),
  ].filter(Boolean) as string[];

  const isAllowed = allowedPaths.some(allowed =>
    normalizedPath.startsWith(path.normalize(allowed))
  );

  if (!isAllowed) {
    return NextResponse.json({ error: 'Path not allowed' }, { status: 403 });
  }

  if (!existsSync(normalizedPath)) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }

  try {
    const content = readFileSync(normalizedPath, 'utf-8');
    return new NextResponse(content, {
      headers: {
        'Content-Type': 'text/html',
      },
    });
  } catch (error) {
    console.error('[FILE] Error reading file:', error);
    return NextResponse.json({ error: 'Failed to read file' }, { status: 500 });
  }
}
