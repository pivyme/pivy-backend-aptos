import { validateFile, uploadLinkFiles, generateSignedUrl } from '../lib/s3Service.js';

/**
 * Process files from multipart form data based on template type
 * @param {Object} request - Fastify request object
 * @param {string} template - Template type (simple-payment, digital-product)
 * @returns {Promise<Object>} - Processed files object
 */
export const processTemplateFiles = async (request, template) => {
  const files = {};
  const errors = [];

  try {
    if (!request.isMultipart()) {
      return { files: {}, errors: [] };
    }

    // Process thumbnail (common for all templates)
    if (request.body.thumbnail && request.body.thumbnail.type === 'file') {
      const thumbnailBuffer = await request.body.thumbnail.toBuffer();
      const thumbnailFile = {
        filename: request.body.thumbnail.filename,
        mimetype: request.body.thumbnail.mimetype,
        buffer: thumbnailBuffer,
      };

      const validation = validateFile(thumbnailFile, 'thumbnail');
      if (!validation.valid) {
        errors.push({ field: 'thumbnail', error: validation.error });
      } else {
        files.thumbnail = thumbnailFile;
      }
    }

    // Process template-specific files
    switch (template) {
      case 'simple-payment':
      case 'fundraiser':
        // Simple payment only needs thumbnail (already processed above)
        break;

      case 'digital-product': {
        // Process multiple deliverable files
        const deliverableFileKeys = Object.keys(request.body).filter(key => 
          key.startsWith('deliverableFile_') && request.body[key].type === 'file'
        );

        for (const fileKey of deliverableFileKeys) {
          const fileData = request.body[fileKey];
          const fileBuffer = await fileData.toBuffer();
          const deliverableFile = {
            filename: fileData.filename,
            mimetype: fileData.mimetype,
            buffer: fileBuffer,
          };

          const validation = validateFile(deliverableFile, 'deliverableFile');
          if (!validation.valid) {
            errors.push({ field: fileKey, error: validation.error });
          } else {
            files[fileKey] = deliverableFile;
          }
        }
        break;
      }

      default:
        // For unknown templates, just process thumbnail
        break;
    }

    return { files, errors };
  } catch (error) {
    console.error('Error processing template files:', error);
    return { 
      files: {}, 
      errors: [{ field: 'general', error: `Failed to process files: ${error.message}` }] 
    };
  }
};

/**
 * Validate template requirements
 * @param {string} template - Template type
 * @param {Object} files - Processed files object
 * @returns {Object} - Validation result
 */
export const validateTemplateRequirements = (template, files) => {
  const errors = [];

  switch (template) {
    case 'simple-payment':
    case 'fundraiser':
      // Thumbnail is optional for simple payment
      break;

    case 'digital-product': {
      // Digital product requires at least one deliverable file
      const deliverableFiles = Object.keys(files).filter(key => key.startsWith('deliverableFile_'));
      if (deliverableFiles.length === 0) {
        errors.push({
          field: 'deliverableFiles',
          error: 'Digital product template requires at least one deliverable file'
        });
      }
      break;
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
};

/**
 * Get template file configuration
 * @param {string} template - Template type
 * @returns {Object} - Template configuration
 */
export const getTemplateConfig = (template) => {
  const configs = {
    'simple-payment': {
      name: 'Simple Payment',
      description: 'Basic payment link with optional thumbnail',
      requiredFiles: [],
      optionalFiles: ['thumbnail'],
      maxFiles: 1,
    },
    'fundraiser': {
      name: 'Fundraiser',
      description: 'Fundraising link with a goal amount',
      requiredFiles: [],
      optionalFiles: ['thumbnail'],
      maxFiles: 1,
    },
    'digital-product': {
      name: 'Digital Product',
      description: 'Product link with deliverable files and thumbnail',
      requiredFiles: ['deliverableFile_1'],
      optionalFiles: ['thumbnail'],
      maxFiles: 10, // thumbnail + up to 9 deliverable files
      deliverableFilePattern: /^deliverableFile_\d+$/,
    },
  };

  return configs[template] || {
    name: 'Unknown Template',
    description: 'Unknown template type',
    requiredFiles: [],
    optionalFiles: [],
    maxFiles: 0,
  };
};

/**
 * Handle file upload for link creation/update
 * @param {string} userId - User ID
 * @param {string} linkId - Link ID
 * @param {string} template - Template type
 * @param {Object} files - Processed files object
 * @returns {Promise<Object>} - Upload results with file records
 */
export const handleLinkFileUpload = async (userId, linkId, template, files) => {
  try {
    // Validate template requirements
    const templateValidation = validateTemplateRequirements(template, files);
    if (!templateValidation.valid) {
      // Don't throw an error for unknown template, just log it
      console.warn(`Template validation failed: ${templateValidation.errors.map(e => e.error).join(', ')}`);
    }

    // Upload files and create File records
    const uploadedFiles = await uploadLinkFiles(userId, linkId, template, files);

    return {
      success: true,
      files: uploadedFiles,
      uploadCount: uploadedFiles.length,
    };
  } catch (error) {
    console.error('File upload error:', error);
    throw new Error(`Failed to upload files: ${error.message}`);
  }
};

/**
 * Extract form data from multipart request
 * @param {Object} request - Fastify request object
 * @returns {Object} - Extracted form data
 */
export const extractFormData = (request) => {
  const data = {};

  if (!request.isMultipart()) {
    // Handle regular JSON body
    return {
      emoji: request.body.emoji || '🔗',
      backgroundColor: request.body.backgroundColor || 'gray',
      tag: request.body.tag || '',
      label: request.body.label,
      description: request.body.description,
      specialTheme: request.body.specialTheme || 'default',
      template: request.body.template || 'simple-payment',
      type: request.body.type || 'simple',
      amountType: request.body.amountType || 'open',
      goalAmount: request.body.goalAmount || null,
      supportedChains: request.body.supportedChains || [],
      chainConfigs: request.body.chainConfigs || [],
      collectInfo: request.body.collectInfo || false,
      collectFields: request.body.collectFields || null,
      // Simplified stablecoin handling
      isStable: request.body.isStable || false,
      stableToken: request.body.stableToken || null,
    };
  }

  // Extract data from multipart form (using .value since attachFieldsToBody is enabled)
  return {
    emoji: request.body.emoji?.value || '🔗',
    backgroundColor: request.body.backgroundColor?.value || 'gray',
    tag: request.body.tag?.value || '',
    label: request.body.label?.value,
    description: request.body.description?.value,
    specialTheme: request.body.specialTheme?.value || 'default',
    template: request.body.template?.value || 'simple-payment',
    type: request.body.type?.value || 'simple',
    amountType: request.body.amountType?.value || 'open',
    goalAmount: request.body.goalAmount?.value || null,
    supportedChains: request.body.supportedChains?.value ? JSON.parse(request.body.supportedChains.value) : [],
    chainConfigs: request.body.chainConfigs?.value ? JSON.parse(request.body.chainConfigs.value) : [],
    collectInfo: request.body.collectInfo?.value === 'true',
    collectFields: request.body.collectFields?.value ? JSON.parse(request.body.collectFields.value) : null,
    // Simplified stablecoin handling
    isStable: request.body.isStable?.value === 'true',
    stableToken: request.body.stableToken?.value || null,
  };
};

/**
 * Get a secure URL for file access
 * @param {Object} file - File object with s3Key and url properties
 * @param {number} expiresIn - Expiration time in seconds (default: 1 hour)
 * @returns {Promise<string>} - Secure URL for file access
 */
export const getSecureFileUrl = async (file, expiresIn = 3600) => {
  try {
    if (!file.s3Key) {
      console.warn('File missing s3Key, falling back to direct URL:', file.id);
      return file.url;
    }
    
    // Generate signed URL for secure access
    const signedUrl = await generateSignedUrl(file.s3Key, expiresIn);
    return signedUrl;
  } catch (error) {
    console.error('Error generating secure URL for file:', file.id, error);
    // Fallback to direct URL
    return file.url;
  }
};

export default {
  processTemplateFiles,
  validateTemplateRequirements,
  getTemplateConfig,
  handleLinkFileUpload,
  extractFormData,
  getSecureFileUrl,
}; 