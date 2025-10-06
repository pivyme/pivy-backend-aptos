/**
 * Utility functions for managing cron schedules based on environment configuration
 * Supports INDEXER_SPEED environment variable to adjust indexing frequency
 * 
 * @param {string} speed - Environment variable value ('default', 'slow', or any other value)
 * @returns {object} Object containing cron schedules for different intervals
 */

/**
 * Get cron schedules based on INDEXER_SPEED environment variable
 * @returns {object} Object with cron schedule strings
 */
export const getCronSchedules = () => {
  const indexerSpeed = process.env.INDEXER_SPEED || 'default';
  
  if (indexerSpeed === 'slow') {
    // Slow mode - reduce frequency to save RPC calls in dev environment
    return {
      // Original: Every 3 seconds -> Slow: Every 20 seconds
      everyThreeSeconds: '*/20 * * * * *',

      // Original: Every 5 seconds -> Slow: Every 30 seconds
      everyFiveSeconds: '*/30 * * * * *',

      // Original: Every 10 seconds -> Slow: Every 2 minutes
      everyTenSeconds: '*/2 * * * *',

      // Original: Every 30 seconds -> Slow: Every 2 minutes
      everyThirtySeconds: '*/2 * * * *',

      // Original: Every 45 seconds -> Slow: Every 3 minutes
      everyFortyFiveSeconds: '*/3 * * * *',

      // Original: Every 2 minutes -> Slow: Every 10 minutes
      everyTwoMinutes: '*/10 * * * *',

      // Original: Every 10 minutes -> Slow: Every 30 minutes
      everyTenMinutes: '*/30 * * * *',

      // Original: Every hour -> Slow: Every 4 hours
      everyHour: '0 */4 * * *'
    };
  }
  
  // Default mode - use original frequencies
  return {
    everyThreeSeconds: '*/3 * * * * *',
    everyFiveSeconds: '*/5 * * * * *',
    everyTenSeconds: '*/10 * * * * *',
    everyThirtySeconds: '*/30 * * * * *',
    everyFortyFiveSeconds: '*/45 * * * * *',
    everyTwoMinutes: '*/2 * * * *',
    everyTenMinutes: '*/10 * * * *',
    everyHour: '0 * * * *'
  };
};

/**
 * Get a specific cron schedule by name
 * @param {string} scheduleName - Name of the schedule to get
 * @returns {string} Cron schedule string
 */
export const getCronSchedule = (scheduleName) => {
  const schedules = getCronSchedules();
  return schedules[scheduleName] || schedules.everyFiveSeconds;
};

/**
 * Log the current indexer speed configuration
 */
export const logIndexerSpeedConfig = () => {
  const speed = process.env.INDEXER_SPEED || 'default';

  console.log(`🚀 Indexer Speed: ${speed.toUpperCase()}`);
  if (speed === 'slow') {
    console.log('⏰ Using slower cron schedules to reduce RPC calls');
    console.log('   - Every 3s → Every 20s');
    console.log('   - Every 5s → Every 30s');
    console.log('   - Every 10s → Every 2min');
    console.log('   - Every 30s → Every 2min');
    console.log('   - Every 2min → Every 10min');
    console.log('   - Every 10min → Every 30min');
    console.log('   - Every hour → Every 4h');
  } else {
    console.log('⚡ Using default cron schedules');
  }
};
