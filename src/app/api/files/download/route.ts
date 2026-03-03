/**
 * File Download API
 * Returns file content over HTTP from the server filesystem OR MinIO bucket.
 * This enables remote agents to read files from
 * the Mission Control server.
 */

import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, existsSync, statSync, realpathSync } from 'fs';
import path from 'path';
import { Client as MinioClient } from 'minio';

export const dynamic = 'force-dynamic';

// Base directory for all project files - must match upload endpoint
const PROJECTS_BASE = (process.env.PROJECTS_PATH || '~/projects').replace(/^~/, process.env.HOME || '');

// MinIO configuration
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

// MIME types for common file extensions
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

/**
 * GET /api/files/download?path=...
 * Download a file from MinIO or the projects directory
 *
 * Query params:
 *   - path: Full path (must be under PROJECTS_BASE or include projects/)
 *   - relativePath: Path relative to PROJECTS_BASE (alternative to path)
 *   - raw: If 'true', returns raw file content; otherwise returns JSON wrapper
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const fullPathParam = searchParams.get('path');
    const relativePathParam = searchParams.get('relativePath');
    const raw = searchParams.get('raw') === 'true';

    // Determine the target path and potential S3 object key
    let targetPath: string = '';
    let objectKey: string | null = null;

    if (fullPathParam) {
      targetPath = path.normalize(fullPathParam);
      // Try resolving projects/ key from absolute path
      const match = targetPath.match(/projects\/(.*)$/);
      if (match) {
        objectKey = `projects/${match[1].replace(/\\/g, '/')}`;
      }
    } else if (relativePathParam) {
      const normalizedRelative = path.normalize(relativePathParam);
      if (normalizedRelative.startsWith('..') || normalizedRelative.startsWith('/')) {
        return NextResponse.json(
          { error: 'Invalid path: must be relative and cannot traverse upward' },
          { status: 400 }
        );
      }
      targetPath = path.join(PROJECTS_BASE, normalizedRelative);
      objectKey = normalizedRelative.includes('projects/') 
        ? normalizedRelative.substring(normalizedRelative.indexOf('projects/')).replace(/\\/g, '/')
        : `projects/${normalizedRelative.replace(/\\/g, '/')}`;
    } else {
      return NextResponse.json(
        { error: 'Either path or relativePath query parameter is required' },
        { status: 400 }
      );
    }

    const minioClient = getMinioClient();
    const bucket = process.env.MINIO_BUCKET || 'mission-files';

    // Try MinIO First
    if (minioClient && objectKey) {
      try {
        const stat = await minioClient.statObject(bucket, objectKey);
        const dataStream = await minioClient.getObject(bucket, objectKey);
        
        const chunks: Buffer[] = [];
        for await (const chunk of dataStream) {
          chunks.push(chunk as Buffer);
        }
        const content = Buffer.concat(chunks);
        
        const ext = path.extname(objectKey).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        const isText = contentType.startsWith('text/') ||
                       contentType === 'application/json' ||
                       contentType === 'application/javascript' ||
                       contentType === 'application/xml';
                       
        console.log(`[FILE DOWNLOAD] Read from MinIO: ${objectKey} (${stat.size} bytes)`);
        
        if (raw) {
          return new NextResponse(content, {
            status: 200,
            headers: {
              'Content-Type': contentType,
              'Content-Length': String(stat.size),
            },
          });
        }
        
        return NextResponse.json({
          success: true,
          path: fullPathParam || targetPath,
          relativePath: objectKey,
          size: stat.size,
          contentType,
          content: isText ? content.toString('utf-8') : content.toString('base64'),
          encoding: isText ? 'utf-8' : 'base64',
          modifiedAt: stat.lastModified.toISOString(),
          source: 'minio'
        });
      } catch (err: any) {
        // Fallback to local FS on any error
        if (err.code !== 'NotFound' && err.code !== 'NoSuchKey') {
           console.error('[MINIO DOWNLOAD] Error fetching object:', err);
        }
      }
    }

    // Check file exists locally
    if (!existsSync(targetPath)) {
      return NextResponse.json(
        { error: 'File not found in MinIO or locally' },
        { status: 404 }
      );
    }

    // Resolve real path and validate it's under PROJECTS_BASE
    // This protects against symlink attacks and path traversal
    let resolvedPath: string;
    try {
      resolvedPath = realpathSync(targetPath);
      const resolvedBase = realpathSync(PROJECTS_BASE);
      
      if (!resolvedPath.startsWith(resolvedBase + path.sep) && resolvedPath !== resolvedBase) {
        console.warn(`[SECURITY] Path traversal attempt blocked: ${targetPath} -> ${resolvedPath}`);
        return NextResponse.json(
          { error: 'Access denied' },
          { status: 403 }
        );
      }
    } catch (error) {
      console.error('[FILE DOWNLOAD] Error resolving path:', error);
      return NextResponse.json(
        { error: 'Access denied' },
        { status: 403 }
      );
    }

    // Use resolved path for all subsequent operations
    targetPath = resolvedPath;

    // Check it's a file, not a directory
    const stats = statSync(targetPath);
    if (stats.isDirectory()) {
      return NextResponse.json(
        { error: 'Path is a directory, not a file', path: targetPath },
        { status: 400 }
      );
    }

    // Determine content type
    const ext = path.extname(targetPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const isText = contentType.startsWith('text/') ||
                   contentType === 'application/json' ||
                   contentType === 'application/javascript' ||
                   contentType === 'application/xml';

    // Read file
    const content = readFileSync(targetPath, isText ? 'utf-8' : undefined);

    console.log(`[FILE DOWNLOAD] Read local FS: ${targetPath} (${stats.size} bytes)`);

    // Return raw content or JSON wrapper
    if (raw) {
      return new NextResponse(content, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(stats.size),
        },
      });
    }

    // JSON response with metadata
    return NextResponse.json({
      success: true,
      path: targetPath,
      relativePath: path.relative(PROJECTS_BASE, targetPath),
      size: stats.size,
      contentType,
      content: isText ? content : Buffer.from(content as Uint8Array).toString('base64'),
      encoding: isText ? 'utf-8' : 'base64',
      modifiedAt: stats.mtime.toISOString(),
      source: 'local'
    });
  } catch (error) {
    console.error('Error downloading file:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
