import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { nanoid } from 'nanoid';
import path from 'path';
import { prismaQuery } from './prisma.js';

// Create S3 client connection
const createS3Client = () => {
  return new S3Client({
    endpoint: process.env.S3_BUCKET_URL,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY,
      secretAccessKey: process.env.S3_SECRET_KEY,
    },
    forcePathStyle: true, // Required for Contabo S3
    region: 'sgp1', // Required for AWS SDK v3
  });
};

/**
 * Generate a unique file key for S3 storage
 * @param {string} userId - User ID
 * @param {string} fileId - File ID from database
 * @param {string} originalFilename - Original filename
 * @returns {string} - Unique S3 key
 */
export const generateFileKey = (userId, fileId, originalFilename) => {
  const extension = path.extname(originalFilename);
  // Use fileId for uniqueness, keep more characters for readability
  // Only replace characters that are problematic for S3 keys
  const sanitizedFilename = path.basename(originalFilename, extension)
    .replace(/[^a-zA-Z0-9\-_.() ]/g, '_')  // Allow more characters including spaces and parentheses
    .replace(/\s+/g, '_');  // Replace spaces with underscores
  
  return `users/${userId}/files/${fileId}_${sanitizedFilename}${extension}`;
};

/**
 * Upload a file to S3
 * @param {Buffer} fileBuffer - File buffer
 * @param {string} s3Key - S3 key/path
 * @param {string} contentType - MIME type
 * @param {Object} metadata - Additional metadata
 * @returns {Promise<Object>} - Upload result with URL and metadata
 */
export const uploadFileToS3 = async (fileBuffer, s3Key, contentType, metadata = {}) => {
  try {
    const s3Client = createS3Client();
    const bucketName = extractBucketName(process.env.S3_BUCKET_URL);
    
    // Always use public-read ACL for all files (especially thumbnails)
    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: s3Key,
      Body: fileBuffer,
      ContentType: contentType,
      ACL: 'public-read',
      Metadata: {
        ...metadata,
        uploadTimestamp: Date.now().toString(),
      },
    });

    await s3Client.send(command);
    console.log('Uploaded file to S3:', s3Key);
    
    // For Contabo S3, construct the public URL correctly
    // The S3_BUCKET_URL already includes the bucket, so we just append the s3Key
    const fileUrl = `${process.env.S3_BUCKET_URL}/${s3Key}`;
    return {
      s3Key,
      url: fileUrl,
      size: fileBuffer.length,
      contentType,
      metadata: {
        ...metadata,
        uploadTimestamp: Date.now().toString(),
      }
    };
  } catch (error) {
    console.error('Upload error:', error);
    throw new Error(`Failed to upload file to S3: ${error.message}`);
  }
};

/**
 * Delete a file from S3
 * @param {string} s3Key - S3 key/path of the file to delete
 * @returns {Promise<boolean>} - Success status
 */
export const deleteFileFromS3 = async (s3Key) => {
  try {
    const s3Client = createS3Client();
    const bucketName = extractBucketName(process.env.S3_BUCKET_URL);
    
    const command = new DeleteObjectCommand({
      Bucket: bucketName,
      Key: s3Key,
    });

    await s3Client.send(command);
    return true;
  } catch (error) {
    console.error('Delete error:', error);
    throw new Error(`Failed to delete file from S3: ${error.message}`);
  }
};

/**
 * Delete multiple files from S3
 * @param {string[]} s3Keys - Array of S3 keys to delete
 * @returns {Promise<Object>} - Result with success/failure counts
 */
export const deleteMultipleFilesFromS3 = async (s3Keys) => {
  const results = {
    successful: [],
    failed: [],
  };

  for (const s3Key of s3Keys) {
    try {
      await deleteFileFromS3(s3Key);
      results.successful.push(s3Key);
    } catch (error) {
      console.error(`Failed to delete ${s3Key}:`, error);
      results.failed.push({ s3Key, error: error.message });
    }
  }

  return results;
};

/**
 * Generate a signed URL for temporary access (if needed for private files)
 * @param {string} s3Key - S3 key/path
 * @param {number} expiresIn - Expiration time in seconds (default: 1 hour)
 * @returns {Promise<string>} - Signed URL
 */
export const generateSignedUrl = async (s3Key, expiresIn = 3600) => {
  try {
    const s3Client = createS3Client();
    const bucketName = extractBucketName(process.env.S3_BUCKET_URL);
    
    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: s3Key,
    });

    const signedUrl = await getSignedUrl(s3Client, command, { expiresIn });
    return signedUrl;
  } catch (error) {
    console.error('Signed URL generation error:', error);
    throw new Error(`Failed to generate signed URL: ${error.message}`);
  }
};

/**
 * Upload a file to S3 and create File record
 * @param {string} userId - User ID
 * @param {Object} fileData - File data with buffer, filename, mimetype
 * @param {string} fileType - File type (THUMBNAIL, DELIVERABLE, etc.)
 * @param {string} category - File category (deliverable_1, deliverable_2, etc.)
 * @param {string} linkId - Optional link ID to associate with
 * @returns {Promise<Object>} - File record from database
 */
export const uploadAndCreateFile = async (userId, fileData, fileType, category = null, linkId = null) => {
  try {
    // First create the file record to get the ID
    const fileRecord = await prismaQuery.file.create({
      data: {
        userId,
        originalName: fileData.filename,
        size: fileData.buffer.length,
        contentType: fileData.mimetype,
        type: fileType,
        category,
        linkId,
        filename: '', // Will be updated after S3 upload
        s3Key: '', // Will be updated after S3 upload
        url: '', // Will be updated after S3 upload
      }
    });

    // Generate S3 key using the file ID
    const s3Key = generateFileKey(userId, fileRecord.id, fileData.filename);
    // Keep the original filename instead of the sanitized S3 key filename
    const filename = fileData.filename;

    // Upload to S3
    const uploadResult = await uploadFileToS3(
      fileData.buffer,
      s3Key,
      fileData.mimetype,
      {
        fileId: fileRecord.id,
        fileType,
        category,
        userId,
        linkId,
        originalFilename: fileData.filename,
      }
    );

    // Update file record with S3 details
    const updatedFile = await prismaQuery.file.update({
      where: { id: fileRecord.id },
      data: {
        filename, // This will now be the original filename
        s3Key: uploadResult.s3Key,
        url: uploadResult.url,
      }
    });

    return updatedFile;
  } catch (error) {
    console.error('Error uploading and creating file:', error);
    throw new Error(`Failed to upload and create file: ${error.message}`);
  }
};

/**
 * Upload multiple files for a link based on template type
 * @param {string} userId - User ID
 * @param {string} linkId - Link ID
 * @param {string} template - Template type (simple-payment, digital-product)
 * @param {Object} files - Files object with different file types
 * @returns {Promise<Array>} - Array of created file records
 */
export const uploadLinkFiles = async (userId, linkId, template, files) => {
  const uploadedFiles = [];

  try {
    // Handle thumbnail (common for all templates)
    if (files.thumbnail) {
      const thumbnailFile = await uploadAndCreateFile(
        userId,
        files.thumbnail,
        'THUMBNAIL',
        null,
        linkId
      );
      uploadedFiles.push(thumbnailFile);
    }

    // Handle template-specific files
    if (template === 'digital-product') {
      // Handle multiple deliverable files
      const deliverableFiles = Object.keys(files).filter(key => key.startsWith('deliverableFile_'));
      
      for (const fileKey of deliverableFiles) {
        const file = files[fileKey];
        const deliverableFile = await uploadAndCreateFile(
          userId,
          file,
          'DELIVERABLE',
          fileKey, // category: deliverable_1, deliverable_2, etc.
          linkId
        );
        uploadedFiles.push(deliverableFile);
      }
    }

    return uploadedFiles;
  } catch (error) {
    // Clean up any successfully uploaded files if there's an error
    if (uploadedFiles.length > 0) {
      const s3Keys = uploadedFiles.map(file => file.s3Key);
      await deleteMultipleFilesFromS3(s3Keys);
      
      // Delete file records
      const fileIds = uploadedFiles.map(file => file.id);
      await prismaQuery.file.deleteMany({
        where: { id: { in: fileIds } }
      });
    }
    throw error;
  }
};

/**
 * Delete all files associated with a link
 * @param {string} linkId - Link ID
 * @returns {Promise<Object>} - Deletion results
 */
export const deleteLinkFiles = async (linkId) => {
  try {
    // Get all files for this link
    const files = await prismaQuery.file.findMany({
      where: { linkId },
      select: { id: true, s3Key: true }
    });

    if (files.length === 0) {
      return { successful: [], failed: [] };
    }

    // Delete from S3
    const s3Keys = files.map(file => file.s3Key);
    const s3Results = await deleteMultipleFilesFromS3(s3Keys);

    // Delete file records from database
    await prismaQuery.file.deleteMany({
      where: { linkId }
    });

    return s3Results;
  } catch (error) {
    console.error('Error deleting link files:', error);
    throw new Error(`Failed to delete link files: ${error.message}`);
  }
};

/**
 * Validate file type and size
 * @param {Object} file - File object with mimetype and buffer
 * @param {string} fileType - Type of file (thumbnail, deliverableFile, etc.)
 * @returns {Object} - Validation result
 */
export const validateFile = (file, fileType) => {
  const maxSizes = {
    thumbnail: 5 * 1024 * 1024, // 5MB for thumbnails
    deliverableFile: 100 * 1024 * 1024, // 100MB for deliverable files
  };

  const allowedMimeTypes = {
    thumbnail: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
    deliverableFile: [
      // Images
      'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
      // Documents
      'application/pdf', 'text/plain', 'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      // Archives
      'application/zip', 'application/x-rar-compressed', 'application/x-7z-compressed',
      // Media
      'video/mp4', 'audio/mpeg', 'audio/wav',
      // Other
      'application/octet-stream'
    ],
  };

  const fileTypeCategory = fileType.startsWith('deliverableFile') ? 'deliverableFile' : fileType;
  const maxSize = maxSizes[fileTypeCategory] || maxSizes.deliverableFile;
  const allowedTypes = allowedMimeTypes[fileTypeCategory] || allowedMimeTypes.deliverableFile;

  if (file.buffer.length > maxSize) {
    return {
      valid: false,
      error: `File size exceeds maximum allowed size of ${Math.round(maxSize / (1024 * 1024))}MB`,
    };
  }

  if (!allowedTypes.includes(file.mimetype)) {
    return {
      valid: false,
      error: `File type ${file.mimetype} is not allowed for ${fileType}`,
    };
  }

  return { valid: true };
};

/**
 * Extract bucket name from S3 URL
 * @param {string} s3Url - S3 bucket URL
 * @returns {string} - Bucket name
 */
const extractBucketName = (s3Url) => {
  try {
    const url = new URL(s3Url);
    // For path-style URLs like https://s3.region.amazonaws.com/bucket-name
    const pathParts = url.pathname.split('/').filter(part => part);
    if (pathParts.length > 0) {
      return pathParts[0];
    }

    // For subdomain-style URLs like https://bucket-name.s3.region.amazonaws.com
    const hostParts = url.hostname.split('.');
    if (hostParts.length > 0) {
      return hostParts[0];
    }

    throw new Error('Could not extract bucket name from URL');
  } catch (error) {
    console.error('Error extracting bucket name:', error);
    throw new Error(`Invalid S3 bucket URL: ${s3Url}`);
  }
};

export default {
  uploadFileToS3,
  deleteFileFromS3,
  deleteMultipleFilesFromS3,
  generateSignedUrl,
  uploadLinkFiles,
  deleteLinkFiles,
  validateFile,
  generateFileKey,
}; 