import { prismaQuery } from '../lib/prisma.js';
import { authMiddleware } from '../middlewares/authMiddleware.js';
import { processTemplateFiles, handleLinkFileUpload } from '../utils/fileHandlers.js';
import { deleteLinkFiles, generateSignedUrl } from '../lib/s3Service.js';

/**
 * File routes for handling file operations
 * @param {import("fastify").FastifyInstance} app
 * @param {*} _
 * @param {Function} done
 */
export const fileRoutes = (app, _, done) => {

  // Rate limit file metadata requests - moderate limits
  app.get('/file/:fileId/info', {
    config: {
      rateLimit: {
        max: 30, // Allow up to 30 metadata requests per minute
        timeWindow: '1 minute'
      }
    }
  }, async (request, reply) => {
    try {
      const { fileId } = request.params;

      const file = await prismaQuery.file.findUnique({
        where: { id: fileId },
        select: {
          id: true,
          filename: true,
          size: true,
          contentType: true,
          url: true,
          s3Key: true, // Added for consistency and potential future use
          type: true,
          category: true,
          user: {
            select: {
              id: true,
              username: true
            }
          },
          link: {
            select: {
              id: true,
              tag: true,
              label: true,
              status: true
            }
          }
        }
      });

      if (!file) {
        return reply.status(404).send({
          success: false,
          message: "File not found",
          error: "The requested file does not exist or has been deleted",
          data: null
        });
      }

      return reply.status(200).send({
        success: true,
        message: "File information retrieved successfully",
        data: file
      });

    } catch (error) {
      console.error('Error getting file info:', error);
      return reply.status(500).send({
        success: false,
        message: "Error getting file information",
        error: error.message,
        data: null
      });
    }
  });

  // Rate limit file access requests - generous for public access
  app.get('/file/:fileId', {
    config: {
      rateLimit: {
        max: 60, // Allow up to 60 file access requests per minute (1 per second)
        timeWindow: '1 minute'
      }
    }
  }, async (request, reply) => {
    try {
      const { fileId } = request.params;

      // Get file record from database
      const file = await prismaQuery.file.findUnique({
        where: { id: fileId },
        select: {
          id: true,
          filename: true,
          size: true,
          contentType: true,
          url: true,
          s3Key: true, // Added for signed URL generation
          type: true,
          category: true,
          user: {
            select: {
              id: true,
              username: true
            }
          },
          link: {
            select: {
              id: true,
              tag: true,
              label: true,
              status: true
            }
          }
        }
      });

      if (!file) {
        return reply.status(404).send({
          success: false,
          message: "File not found",
          error: "The requested file does not exist or has been deleted",
          data: null
        });
      }

      // Check if the associated link is still active (if it has one)
      if (file.link && file.link.status !== 'ACTIVE') {
        return reply.status(404).send({
          success: false,
          message: "File not available",
          error: "The file is associated with an inactive link",
          data: null
        });
      }

      // Use signed URLs since Contabo bucket policy blocks public access
      try {
        const signedUrl = await generateSignedUrl(file.s3Key, 3600); // 1 hour expiration
        console.log('Generated signed URL for file access:', file.id);
        
        return reply.redirect(signedUrl, 302);
      } catch (signedUrlError) {
        console.error('Error generating signed URL:', signedUrlError);
        
        // Fallback to direct URL if signed URL fails
        console.log('Falling back to direct URL:', file.url);
        try {
          new URL(file.url); // Validate URL
          return reply.redirect(file.url, 302);
        } catch (urlError) {
          console.error('Invalid fallback URL:', file.url, urlError);
          return reply.status(500).send({
            success: false,
            message: "Unable to access file",
            error: "Failed to generate secure access URL",
            data: null
          });
        }
      }

    } catch (error) {
      console.error('Error accessing file:', error);
      return reply.status(500).send({
        success: false,
        message: "Error accessing file",
        error: error.message,
        data: null
      });
    }
  });

  // Rate limit file uploads - moderate limits
  app.post('/upload/:linkId', {
    preHandler: [authMiddleware],
    config: {
      rateLimit: {
        max: 20, // Allow up to 20 file upload requests per minute
        timeWindow: '1 minute'
      }
    }
  }, async (request, reply) => {
    try {
      const { linkId } = request.params;
      
      // Verify link exists and belongs to user
      const existingLink = await prismaQuery.link.findFirst({
        where: { 
          id: linkId,
          userId: request.user.id,
          status: 'ACTIVE'
        }
      });

      if (!existingLink) {
        return reply.status(404).send({
          message: "Link not found",
          error: "Link not found or you don't have permission to upload files to it",
          data: null
        });
      }

      // Process template-specific files
      const { files, errors: fileErrors } = await processTemplateFiles(request, existingLink.template);
      
      if (fileErrors.length > 0) {
        return reply.status(400).send({
          message: "File validation errors",
          error: "FILE_VALIDATION_ERROR",
          data: { fileErrors }
        });
      }

      if (Object.keys(files).length === 0) {
        return reply.status(400).send({
          message: "No files provided",
          error: "NO_FILES_PROVIDED",
          data: null
        });
      }

      // Handle file uploads
      try {
        const uploadResult = await handleLinkFileUpload(
          request.user.id,
          linkId,
          existingLink.template,
          files
        );
        
        // Merge with existing files (don't overwrite other file types)
        const updatedFiles = {
          ...(existingLink.files || {}),
          ...uploadResult.filesMetadata
        };

        // Update the link with new files
        const updatedLink = await prismaQuery.link.update({
          where: { id: linkId },
          data: {
            files: updatedFiles
          }
        });

        return reply.status(200).send({
          message: "Files uploaded successfully",
          data: {
            linkId: linkId,
            uploadedFiles: Object.keys(uploadResult.filesMetadata),
            totalFiles: Object.keys(updatedFiles).length,
            files: updatedFiles
          }
        });

      } catch (uploadError) {
        return reply.status(500).send({
          message: "File upload failed",
          error: uploadError.message,
          data: null
        });
      }

    } catch (error) {
      console.error('Error uploading files:', error);
      return reply.status(500).send({
        message: "Error uploading files",
        error: error.message,
        data: null
      });
    }
  });

  // Rate limit file deletions - moderate limits
  app.delete('/delete/:linkId/:fileType', {
    preHandler: [authMiddleware],
    config: {
      rateLimit: {
        max: 15, // Allow up to 15 file deletion requests per minute
        timeWindow: '1 minute'
      }
    }
  }, async (request, reply) => {
    try {
      const { linkId, fileType } = request.params;
      
      // Verify link exists and belongs to user
      const existingLink = await prismaQuery.link.findFirst({
        where: { 
          id: linkId,
          userId: request.user.id,
          status: 'ACTIVE'
        }
      });

      if (!existingLink) {
        return reply.status(404).send({
          message: "Link not found",
          error: "Link not found or you don't have permission to modify it",
          data: null
        });
      }

      if (!existingLink.files || !existingLink.files[fileType]) {
        return reply.status(404).send({
          message: "File not found",
          error: `File type '${fileType}' not found for this link`,
          data: null
        });
      }

      // Delete from S3
      try {
        const fileToDelete = { [fileType]: existingLink.files[fileType] };
        await deleteLinkFiles(fileToDelete);
      } catch (deleteError) {
        console.error('Error deleting from S3:', deleteError);
        // Continue with database update even if S3 deletion fails
      }

      // Remove from database
      const updatedFiles = { ...existingLink.files };
      delete updatedFiles[fileType];

      await prismaQuery.link.update({
        where: { id: linkId },
        data: {
          files: Object.keys(updatedFiles).length > 0 ? updatedFiles : null
        }
      });

      return reply.status(200).send({
        message: "File deleted successfully",
        data: {
          linkId: linkId,
          deletedFileType: fileType,
          remainingFiles: Object.keys(updatedFiles)
        }
      });

    } catch (error) {
      console.error('Error deleting file:', error);
      return reply.status(500).send({
        message: "Error deleting file",
        error: error.message,
        data: null
      });
    }
  });

  // Rate limit file metadata requests - moderate limits
  app.get('/metadata/:linkId', {
    preHandler: [authMiddleware],
    config: {
      rateLimit: {
        max: 30, // Allow up to 30 metadata requests per minute
        timeWindow: '1 minute'
      }
    }
  }, async (request, reply) => {
    try {
      const { linkId } = request.params;
      
      // Verify link exists and belongs to user
      const link = await prismaQuery.link.findFirst({
        where: { 
          id: linkId,
          userId: request.user.id,
          status: 'ACTIVE'
        },
        select: {
          id: true,
          template: true,
          files: true
        }
      });

      if (!link) {
        return reply.status(404).send({
          message: "Link not found",
          error: "Link not found or you don't have permission to view it",
          data: null
        });
      }

      return reply.status(200).send({
        message: "File metadata retrieved successfully",
        data: {
          linkId: linkId,
          template: link.template,
          files: link.files || {},
          fileCount: link.files ? Object.keys(link.files).length : 0
        }
      });

    } catch (error) {
      console.error('Error getting file metadata:', error);
      return reply.status(500).send({
        message: "Error getting file metadata",
        error: error.message,
        data: null
      });
    }
  });

  done();
};

export default fileRoutes; 