import { prismaQuery } from "../lib/prisma.js";

/**
 * Check if a process should be executed based on ProcessingLog
 * @param {string} processId - The ID of the process (e.g., txHash, composite key)
 * @param {string} type - The type of processing (from ProcessingType enum)
 * @returns {Promise<boolean>} - Whether the process should be executed
 */
export const shouldProcess = async (processId, type) => {
  const log = await prismaQuery.processingLog.findUnique({
    where: {
      processId_type: {
        processId,
        type
      }
    }
  });

  // If no log exists, should process
  if (!log) return true;

  // If already processed, don't process
  if (log.isProcessed) return false;

  // If max retries reached, don't process
  if (log.processedCount >= log.maxRetries) return false;

  // Otherwise, should process
  return true;
};

/**
 * Mark a process as attempted (increment processedCount)
 * @param {string} processId - The ID of the process
 * @param {string} type - The type of processing
 * @param {boolean} success - Whether the processing was successful
 * @returns {Promise<void>}
 */
export const markProcessAttempt = async (processId, type, success = false) => {
  const now = new Date();
  
  await prismaQuery.processingLog.upsert({
    where: {
      processId_type: {
        processId,
        type
      }
    },
    update: {
      processedCount: {
        increment: 1
      },
      isProcessed: success,
      lastProcessedAt: now,
      updatedAt: now
    },
    create: {
      processId,
      type,
      processedCount: 1,
      isProcessed: success,
      lastProcessedAt: now
    }
  });
};

/**
 * Mark a process as successfully completed
 * @param {string} processId - The ID of the process
 * @param {string} type - The type of processing
 * @returns {Promise<void>}
 */
export const markProcessComplete = async (processId, type) => {
  await markProcessAttempt(processId, type, true);
};

/**
 * Reset processing log for a specific process (useful for reprocessing)
 * @param {string} processId - The ID of the process
 * @param {string} type - The type of processing
 * @returns {Promise<void>}
 */
export const resetProcessingLog = async (processId, type) => {
  await prismaQuery.processingLog.deleteMany({
    where: {
      processId,
      type
    }
  });
};

/**
 * Get all unprocessed items for a specific processing type
 * @param {string} type - The type of processing
 * @param {number} limit - Maximum number of items to return
 * @returns {Promise<string[]>} - Array of processIds that need processing
 */
export const getUnprocessedItems = async (type, limit = 50) => {
  const logs = await prismaQuery.processingLog.findMany({
    where: {
      type,
      isProcessed: false,
      processedCount: {
        lt: 5 // Less than max retries
      }
    },
    select: {
      processId: true
    },
    take: limit,
    orderBy: {
      createdAt: 'asc'
    }
  });

  return logs.map(log => log.processId);
};
