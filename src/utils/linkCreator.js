import { prismaQuery } from "../lib/prisma.js";
import { processTemplateFiles, extractFormData, handleLinkFileUpload } from './fileHandlers.js';
import { deleteLinkFiles } from '../lib/s3Service.js';
import { getOrCreateMintData } from "./linkUtils.js";
import { getAlphanumericId } from "./miscUtils.js";


export const handleCreateLink = async (request, reply) => {
    try {
        console.log('create-link called');

        // Check user's current active link count
        const userActiveLinksCount = await prismaQuery.link.count({
            where: {
                userId: request.user.id,
                status: 'ACTIVE'
            }
        });

        // Enforce 50 link limit per user
        if (userActiveLinksCount >= 50) {
            return reply.status(429).send({
                message: "Link creation limit reached",
                error: "LINK_LIMIT_EXCEEDED",
                data: {
                    currentCount: userActiveLinksCount,
                    maxAllowed: 50
                }
            });
        }

        // Extract form data using the new helper
        const data = extractFormData(request);
        console.log('Processed form data:', data);

        // Process template-specific files
        const { files, errors: fileErrors } = await processTemplateFiles(request, data.template);

        if (fileErrors.length > 0) {
            return reply.status(400).send({
                message: "File validation errors",
                error: "FILE_VALIDATION_ERROR",
                data: { fileErrors }
            });
        }

        // Generate label from tag if not provided (slug to human readable)
        if (!data.label && data.tag) {
            // Convert slug back to human readable label
            data.label = data.tag.split('-').map(word =>
                word.charAt(0).toUpperCase() + word.slice(1)
            ).join(' ');
        }

        // Check if an active link with the same tag already exists
        const existingActiveLink = await prismaQuery.link.findFirst({
            where: {
                userId: request.user.id,
                tag: data.tag,
                status: 'ACTIVE'
            }
        });

        if (existingActiveLink) {
            return reply.status(409).send({ // 409 Conflict
                message: "An active link with this tag already exists.",
                error: "DUPLICATE_ACTIVE_LINK_TAG",
                data: {
                    tag: data.tag
                }
            });
        }

        // Validate required fields
        if (!data.label) {
            return reply.status(400).send({
                message: "Label is required",
                error: "MISSING_REQUIRED_FIELD",
                data: null
            });
        }

        if (!data.supportedChains || data.supportedChains.length === 0) {
            return reply.status(400).send({
                message: "At least one supported chain is required",
                error: "MISSING_SUPPORTED_CHAINS",
                data: null
            });
        }

        if (!data.chainConfigs || data.chainConfigs.length === 0) {
            return reply.status(400).send({
                message: "Chain configurations are required",
                error: "MISSING_CHAIN_CONFIGS",
                data: null
            });
        }

        // Process chain configs to get or create mint data
        const processedChainConfigs = await Promise.all(
            data.chainConfigs.map(async (config) => {
                let mintId = null;

                // Handle mint data for all cases where mint address is provided
                if (config.mint) {
                    try {
                        // Get or create mint data for this token
                        // Pass the isNative flag from the request to properly handle native vs wrapped tokens
                        const mintData = await getOrCreateMintData(
                            config.chain,
                            config.mint,
                            config.isNative || false
                        );
                        mintId = mintData.id;
                    } catch (error) {
                        console.error(`Error processing mint ${config.mint} for chain ${config.chain}:`, error);
                        // For now, continue without mintId - this allows the link to be created
                        // even if mint data processing fails
                        mintId = null;
                    }
                }

                const chainConfig = {
                    chain: config.chain,
                    amount: config.amount ? parseFloat(config.amount) : null,
                    mintId,
                    isEnabled: config.isEnabled !== false
                };

                if (data.template === 'fundraiser') {
                    chainConfig.goalAmount = config.goalAmount ? parseFloat(config.goalAmount) : null;
                }

                return chainConfig
            })
        );

        // Base link data
        const linkData = {
            userId: request.user.id,
            tag: data.tag,
            label: data.label,
            description: data.description,
            type: data.type.toUpperCase(),
            amountType: data.amountType.toUpperCase(),
            emoji: data.emoji,
            backgroundColor: data.backgroundColor,
            specialTheme: data.specialTheme,
            template: data.template,
            collectInfo: data.collectInfo,
            collectFields: data.collectFields,
            supportedChains: data.supportedChains,
            // Simplified stablecoin handling
            isStable: data.isStable || false,
            stableToken: data.stableToken || null,
            status: 'ACTIVE'
        };

        if (data.template === 'fundraiser') {
            linkData.goalAmount = data.goalAmount ? parseFloat(data.goalAmount) : null;
        }

        let link;
        let uploadedFiles = [];

        // Create new link
        link = await prismaQuery.link.create({
            data: {
                id: getAlphanumericId(8),
                ...linkData,
                chainConfigs: {
                    create: processedChainConfigs
                }
            },
            include: {
                chainConfigs: {
                    include: {
                        mint: true
                    }
                },
                files: {
                    select: {
                        id: true,
                        type: true,
                        category: true,
                        filename: true,
                        size: true,
                        contentType: true
                    }
                }
            }
        });

        // Handle file uploads after link is created (so we have the real link ID)
        if (Object.keys(files).length > 0) {
            try {
                const uploadResult = await handleLinkFileUpload(
                    request.user.id,
                    link.id, // Use the actual link ID
                    data.template,
                    files
                );
                uploadedFiles = uploadResult.files;
            } catch (uploadError) {
                // If file upload fails, we should clean up the created link
                await prismaQuery.link.delete({ where: { id: link.id } });
                return reply.status(500).send({
                    message: "File upload failed",
                    error: uploadError.message,
                    data: null
                });
            }
        }

        // Files are already properly formatted for response (no binary data)

        // Format chain configs for response
        const formattedChainConfigs = link.chainConfigs.map(config => {
            let chainAmount = null;

            // Calculate chain amount if we have both amount and mint data
            if (config.amount && config.mint && config.mint.decimals !== undefined) {
                try {
                    const amountInSmallestUnit = config.amount * (10 ** config.mint.decimals);
                    chainAmount = BigInt(Math.floor(amountInSmallestUnit)).toString();
                } catch (error) {
                    console.error(`Error calculating chain amount for ${config.chain}:`, error);
                    chainAmount = null;
                }
            }

            return {
                chain: config.chain,
                amount: config.amount,
                goalAmount: config.goalAmount,
                isEnabled: config.isEnabled,
                mint: config.mint ? {
                    ...config.mint,
                    isNative: config.mint.isNative || false
                } : null,
                chainAmount,
                isNative: config.mint ? config.mint.isNative || false : false
            };
        });

        // Organize files by type for easy access (combine uploaded files with existing files)
        const allFiles = [...(link.files || []), ...uploadedFiles];
        const organizedFiles = {
            thumbnail: allFiles.find(f => f.type === 'THUMBNAIL') || null,
            deliverables: allFiles.filter(f => f.type === 'DELIVERABLE') || []
        };

        return reply.status(201).send({
            success: true,
            message: 'Link created successfully',
            data: {
                ...link,
                chainConfigs: formattedChainConfigs,
                files: organizedFiles
            }
        });
    } catch (error) {
        console.log('Error creating link', error);

        // Handle specific file size error
        if (error.code === 'FST_REQ_FILE_TOO_LARGE') {
            return reply.status(413).send({
                message: "File size too large",
                error: "Maximum file size is 5MB",
                data: null
            });
        }

        return reply.status(500).send({
            message: "Error creating link",
            error: error.message,
            data: null
        });
    }
}

export const handleUpdateLink = async (request, reply) => {
    try {
        const { linkId } = request.params;

        // 1. Verify link belongs to user
        const existingLink = await prismaQuery.link.findUnique({
            where: { id: linkId },
            include: { files: true }
        });

        if (!existingLink || existingLink.userId !== request.user.id) {
            return reply.status(404).send({ message: "Link not found or you don't have permission to edit it.", error: "LINK_NOT_FOUND" });
        }

        // 2. Extract form data
        const data = extractFormData(request);
        console.log('Processed form data for update:', data);

        // 3. Process template-specific files from the request
        const { files: newFiles, errors: fileErrors } = await processTemplateFiles(request, data.template);

        if (fileErrors.length > 0) {
            return reply.status(400).send({
                message: "File validation errors",
                error: "FILE_VALIDATION_ERROR",
                data: { fileErrors }
            });
        }

        // 4. Generate label from tag if not provided
        if (!data.label && data.tag) {
            data.label = data.tag.split('-').map(word =>
                word.charAt(0).toUpperCase() + word.slice(1)
            ).join(' ');
        }

        // 5. Check if an active link with the same tag already exists for this user (and it's not the current link)
        if (data.tag) {
            const existingActiveLinkWithTag = await prismaQuery.link.findFirst({
                where: {
                    userId: request.user.id,
                    tag: data.tag,
                    status: 'ACTIVE',
                    id: { not: linkId }
                }
            });

            if (existingActiveLinkWithTag) {
                return reply.status(409).send({
                    message: "An active link with this tag already exists.",
                    error: "DUPLICATE_ACTIVE_LINK_TAG",
                    data: { tag: data.tag }
                });
            }
        }

        // 6. Validate required fields
        if (!data.label) {
            return reply.status(400).send({ message: "Label is required", error: "MISSING_REQUIRED_FIELD" });
        }
        if (!data.supportedChains || data.supportedChains.length === 0) {
            return reply.status(400).send({ message: "At least one supported chain is required", error: "MISSING_SUPPORTED_CHAINS" });
        }
        if (!data.chainConfigs || data.chainConfigs.length === 0) {
            return reply.status(400).send({ message: "Chain configurations are required", error: "MISSING_CHAIN_CONFIGS" });
        }
        // Validate chainConfigs
        for (const config of data.chainConfigs) {
            if (!config.chain || !['APTOS_MAINNET', 'APTOS_TESTNET'].includes(config.chain)) {
                return reply.status(400).send({ message: 'Invalid chain in configuration. Only APTOS_MAINNET and APTOS_TESTNET are supported.' });
            }
        }

        // 7. Process chain configs
        const processedChainConfigs = await Promise.all(
            data.chainConfigs.map(async (config) => {
                let mintId = null;
                if (config.mint) {
                    try {
                        const mintData = await getOrCreateMintData(
                            config.chain,
                            config.mint,
                            config.isNative || false
                        );
                        mintId = mintData.id;
                    } catch (error) {
                        console.error(`Error processing mint ${config.mint} for chain ${config.chain}:`, error);
                        mintId = null;
                    }
                }
                const chainConfig = {
                    chain: config.chain,
                    amount: config.amount ? parseFloat(config.amount) : null,
                    mintId,
                    isEnabled: config.isEnabled !== false
                };
                if (data.template === 'fundraiser') {
                    chainConfig.goalAmount = config.goalAmount ? parseFloat(config.goalAmount) : null;
                }
                return chainConfig;
            })
        );

        // 8. Handle file updates
        let uploadedFilesData = [];
        const hasNewFiles = Object.keys(newFiles).length > 0;

        // Get list of existing deliverable IDs to keep (for digital products)
        const existingDeliverableIds = data.existingDeliverableIds
            ? JSON.parse(data.existingDeliverableIds)
            : null; // null means no deliverable tracking was sent

        // Only process file updates if:
        // 1. There are new files to upload, OR
        // 2. For digital products, if existingDeliverableIds was explicitly sent (means user interacted with deliverables)
        const shouldProcessFiles = hasNewFiles || (data.template === 'digital-product' && existingDeliverableIds !== null);

        if (shouldProcessFiles) {
            // For digital products, selectively manage deliverable files
            if (data.template === 'digital-product' && existingDeliverableIds !== null && existingLink.files.length > 0) {
                // Get all existing deliverable files
                const existingDeliverables = existingLink.files.filter(f => f.type === 'DELIVERABLE');

                // Delete deliverables that are not in the keep list
                const filesToDelete = existingDeliverables.filter(f => !existingDeliverableIds.includes(f.id));

                for (const file of filesToDelete) {
                    try {
                        await prismaQuery.file.delete({ where: { id: file.id } });
                        console.log(`Deleted deliverable file: ${file.id}`);
                    } catch (err) {
                        console.error(`Failed to delete file ${file.id}:`, err);
                    }
                }
            }

            // Handle thumbnail replacement
            if (newFiles.thumbnail && existingLink.files.length > 0) {
                const oldThumbnail = existingLink.files.find(f => f.type === 'THUMBNAIL');
                if (oldThumbnail) {
                    try {
                        await prismaQuery.file.delete({ where: { id: oldThumbnail.id } });
                        console.log(`Deleted old thumbnail: ${oldThumbnail.id}`);
                    } catch (err) {
                        console.error(`Failed to delete thumbnail ${oldThumbnail.id}:`, err);
                    }
                }
            }

            // For non-digital-product templates, delete all old files if new ones are uploaded
            if (data.template !== 'digital-product' && hasNewFiles && existingLink.files.length > 0) {
                await deleteLinkFiles(linkId);
            }

            // Upload new files
            if (hasNewFiles) {
                try {
                    const uploadResult = await handleLinkFileUpload(
                        request.user.id,
                        linkId,
                        data.template,
                        newFiles
                    );
                    uploadedFilesData = uploadResult.files;
                } catch (uploadError) {
                    return reply.status(500).send({
                        message: "File upload failed",
                        error: uploadError.message,
                    });
                }
            }
        }


        // 9. Base link data for update
        const linkData = {
            tag: data.tag,
            label: data.label,
            description: data.description,
            type: data.type.toUpperCase(),
            amountType: data.amountType.toUpperCase(),
            emoji: data.emoji,
            backgroundColor: data.backgroundColor,
            specialTheme: data.specialTheme,
            template: data.template,
            collectInfo: data.collectInfo,
            collectFields: data.collectFields,
            supportedChains: data.supportedChains,
            // Simplified stablecoin handling
            isStable: data.isStable || false,
            stableToken: data.stableToken || null
        };

        if (data.template === 'fundraiser') {
            linkData.goalAmount = data.goalAmount ? parseFloat(data.goalAmount) : null;
        }

        // 10. Update link and chain configs in a transaction
        const updatedLinkFromDb = await prismaQuery.$transaction(async (prisma) => {
            // Delete old chain configs
            await prisma.linkChainConfig.deleteMany({
                where: { linkId: linkId }
            });

            // Update link and create new chain configs
            const link = await prisma.link.update({
                where: { id: linkId },
                data: {
                    ...linkData,
                    chainConfigs: {
                        create: processedChainConfigs
                    }
                },
                include: {
                    chainConfigs: {
                        include: { mint: true }
                    },
                    files: {
                        select: {
                            id: true,
                            type: true,
                            category: true,
                            filename: true,
                            size: true,
                            contentType: true
                        }
                    }
                }
            });
            return link;
        });


        // 11. Format response
        const formattedChainConfigs = updatedLinkFromDb.chainConfigs.map(config => {
            let chainAmount = null;
            if (config.amount && config.mint && config.mint.decimals !== undefined) {
                try {
                    const amountInSmallestUnit = config.amount * (10 ** config.mint.decimals);
                    chainAmount = BigInt(Math.floor(amountInSmallestUnit)).toString();
                } catch (error) {
                    console.error(`Error calculating chain amount for ${config.chain}:`, error);
                    chainAmount = null;
                }
            }
            return {
                chain: config.chain,
                amount: config.amount,
                goalAmount: config.goalAmount,
                isEnabled: config.isEnabled,
                mint: config.mint ? { ...config.mint, isNative: config.mint.isNative || false } : null,
                chainAmount,
                isNative: config.mint ? config.mint.isNative || false : false
            };
        });

        const allFiles = [...(updatedLinkFromDb.files || []), ...uploadedFilesData];
        const organizedFiles = {
            thumbnail: allFiles.find(f => f.type === 'THUMBNAIL') || null,
            deliverables: allFiles.filter(f => f.type === 'DELIVERABLE') || []
        };

        return reply.status(200).send({
            success: true,
            message: 'Link updated successfully',
            data: {
                ...updatedLinkFromDb,
                chainConfigs: formattedChainConfigs,
                files: organizedFiles
            }
        });

    } catch (error) {
        console.log('Error updating link', error);
        if (error.code === 'FST_REQ_FILE_TOO_LARGE') {
            return reply.status(413).send({
                message: "File size too large",
                error: "Maximum file size is 5MB",
            });
        }
        return reply.status(500).send({
            message: "Error updating link",
            error: error.message,
        });
    }
}
