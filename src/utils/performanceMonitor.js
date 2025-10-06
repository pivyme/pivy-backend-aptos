/**
 * Performance monitoring utility for tracking memory usage, execution time, and resources
 */

class PerformanceMonitor {
  constructor(label = 'Operation') {
    this.label = label;
    this.startTime = null;
    this.startMemory = null;
    this.startCpuUsage = null;
  }

  /**
   * Start monitoring performance
   */
  start() {
    // Record start time with high precision
    this.startTime = process.hrtime.bigint();
    
    // Record memory usage at start
    this.startMemory = process.memoryUsage();
    
    // Record CPU usage at start (if available)
    if (process.cpuUsage) {
      this.startCpuUsage = process.cpuUsage();
    }

    console.log(`🚀 [PERF] Starting ${this.label}`);
    console.log(`📊 [PERF] Initial Memory Usage:`, {
      rss: `${(this.startMemory.rss / 1024 / 1024).toFixed(2)} MB`,
      heapTotal: `${(this.startMemory.heapTotal / 1024 / 1024).toFixed(2)} MB`,
      heapUsed: `${(this.startMemory.heapUsed / 1024 / 1024).toFixed(2)} MB`,
      external: `${(this.startMemory.external / 1024 / 1024).toFixed(2)} MB`,
      arrayBuffers: `${(this.startMemory.arrayBuffers / 1024 / 1024).toFixed(2)} MB`
    });

    return this;
  }

  /**
   * Stop monitoring and log results
   */
  stop() {
    if (!this.startTime) {
      console.warn(`⚠️ [PERF] ${this.label}: start() was not called`);
      return null;
    }

    // Calculate execution time
    const endTime = process.hrtime.bigint();
    const executionTimeNs = Number(endTime - this.startTime);
    const executionTimeMs = executionTimeNs / 1000000;

    // Get final memory usage
    const endMemory = process.memoryUsage();

    // Calculate memory differences
    const memoryDiff = {
      rss: endMemory.rss - this.startMemory.rss,
      heapTotal: endMemory.heapTotal - this.startMemory.heapTotal,
      heapUsed: endMemory.heapUsed - this.startMemory.heapUsed,
      external: endMemory.external - this.startMemory.external,
      arrayBuffers: endMemory.arrayBuffers - this.startMemory.arrayBuffers
    };

    // Calculate CPU usage if available
    let cpuDiff = null;
    if (this.startCpuUsage && process.cpuUsage) {
      const endCpuUsage = process.cpuUsage(this.startCpuUsage);
      cpuDiff = {
        user: endCpuUsage.user / 1000, // Convert microseconds to milliseconds
        system: endCpuUsage.system / 1000
      };
    }

    const results = {
      label: this.label,
      executionTime: {
        nanoseconds: executionTimeNs,
        milliseconds: executionTimeMs,
        seconds: executionTimeMs / 1000
      },
      memory: {
        initial: this.startMemory,
        final: endMemory,
        diff: memoryDiff,
        diffFormatted: {
          rss: `${(memoryDiff.rss / 1024 / 1024).toFixed(2)} MB`,
          heapTotal: `${(memoryDiff.heapTotal / 1024 / 1024).toFixed(2)} MB`,
          heapUsed: `${(memoryDiff.heapUsed / 1024 / 1024).toFixed(2)} MB`,
          external: `${(memoryDiff.external / 1024 / 1024).toFixed(2)} MB`,
          arrayBuffers: `${(memoryDiff.arrayBuffers / 1024 / 1024).toFixed(2)} MB`
        }
      },
      cpu: cpuDiff
    };

    // Log results
    console.log(`✅ [PERF] Completed ${this.label}`);
    console.log(`⏱️ [PERF] Execution Time: ${executionTimeMs.toFixed(2)}ms (${(executionTimeMs / 1000).toFixed(3)}s)`);
    console.log(`📊 [PERF] Final Memory Usage:`, {
      rss: `${(endMemory.rss / 1024 / 1024).toFixed(2)} MB`,
      heapTotal: `${(endMemory.heapTotal / 1024 / 1024).toFixed(2)} MB`,
      heapUsed: `${(endMemory.heapUsed / 1024 / 1024).toFixed(2)} MB`,
      external: `${(endMemory.external / 1024 / 1024).toFixed(2)} MB`,
      arrayBuffers: `${(endMemory.arrayBuffers / 1024 / 1024).toFixed(2)} MB`
    });
    console.log(`📈 [PERF] Memory Changes:`, results.memory.diffFormatted);
    
    if (cpuDiff) {
      console.log(`🖥️ [PERF] CPU Usage: User ${cpuDiff.user.toFixed(2)}ms, System ${cpuDiff.system.toFixed(2)}ms`);
    }

    // Performance assessment
    const isMemoryHeavy = Math.abs(memoryDiff.heapUsed) > 50 * 1024 * 1024; // > 50MB
    const isTimeHeavy = executionTimeMs > 1000; // > 1 second
    
    if (isMemoryHeavy || isTimeHeavy) {
      console.log(`⚠️ [PERF] HEAVY OPERATION DETECTED:`);
      if (isMemoryHeavy) {
        console.log(`   - High memory usage: ${results.memory.diffFormatted.heapUsed}`);
      }
      if (isTimeHeavy) {
        console.log(`   - Long execution time: ${executionTimeMs.toFixed(2)}ms`);
      }
    } else {
      console.log(`✨ [PERF] Operation is lightweight`);
    }

    console.log(`📋 [PERF] Raw metrics:`, JSON.stringify({
      executionTimeMs: parseFloat(executionTimeMs.toFixed(2)),
      memoryDiffMB: {
        rss: parseFloat((memoryDiff.rss / 1024 / 1024).toFixed(2)),
        heapUsed: parseFloat((memoryDiff.heapUsed / 1024 / 1024).toFixed(2)),
        heapTotal: parseFloat((memoryDiff.heapTotal / 1024 / 1024).toFixed(2))
      },
      cpuMs: cpuDiff ? {
        user: parseFloat(cpuDiff.user.toFixed(2)),
        system: parseFloat(cpuDiff.system.toFixed(2))
      } : null
    }, null, 2));

    return results;
  }

  /**
   * Static helper method to create and start monitoring in one call
   */
  static start(label) {
    return new PerformanceMonitor(label).start();
  }
}

/**
 * Elegant performance monitoring middleware that can be added with just one line
 * Usage: preHandler: [authMiddleware, performanceMonitor('Route Name')]
 */
function performanceMonitor(routeName) {
  return async (request, reply) => {
    // Start monitoring
    const userId = request.user?.id || 'Anonymous';
    const monitor = PerformanceMonitor.start(`${routeName} - User ${userId}`);
    
    // Store monitor for potential manual access
    request.performanceMonitor = monitor;
    
    // Hook into the response to automatically stop monitoring
    const originalSend = reply.send.bind(reply);
    reply.send = function(payload) {
      try {
        // Stop monitoring and get results
        const perfResults = monitor.stop();
        
        // Add performance metrics to response if it's an object
        if (typeof payload === 'object' && payload !== null && !Buffer.isBuffer(payload)) {
          payload._performanceMetrics = {
            executionTimeMs: perfResults.executionTime.milliseconds,
            memoryUsedMB: perfResults.memory.diffFormatted.heapUsed,
            isHeavyOperation: perfResults.executionTime.milliseconds > 1000 || Math.abs(perfResults.memory.diff.heapUsed) > 50 * 1024 * 1024,
            timestamp: new Date().toISOString()
          };
        }
        
        // Add performance headers
        this.header('X-Performance-Time-Ms', perfResults.executionTime.milliseconds.toFixed(2));
        this.header('X-Performance-Memory-MB', (perfResults.memory.diff.heapUsed / 1024 / 1024).toFixed(2));
        this.header('X-Performance-Heavy', perfResults.executionTime.milliseconds > 1000 || Math.abs(perfResults.memory.diff.heapUsed) > 50 * 1024 * 1024);
        
      } catch (error) {
        console.error('Error in performance monitoring:', error);
      }
      
      // Call original send
      return originalSend(payload);
    };

    // Handle errors by ensuring monitor is stopped
    reply.onError = function(error) {
      try {
        if (monitor) {
          monitor.stop();
          console.error(`❌ [PERF] ${routeName} failed with error:`, error.message);
        }
      } catch (perfError) {
        console.error('Error stopping performance monitor:', perfError);
      }
    };
  };
}

/**
 * @deprecated Use performanceMonitor() instead
 * Middleware factory for automatically monitoring route performance
 */
function createPerformanceMiddleware(routeName) {
  return performanceMonitor(routeName);
}

/**
 * Helper function to wrap async functions with performance monitoring
 */
async function withPerformanceMonitoring(label, asyncFn) {
  const monitor = PerformanceMonitor.start(label);
  try {
    const result = await asyncFn();
    monitor.stop();
    return result;
  } catch (error) {
    monitor.stop();
    console.error(`❌ [PERF] ${label} failed with error:`, error.message);
    throw error;
  }
}

export {
  PerformanceMonitor,
  performanceMonitor,
  createPerformanceMiddleware, // deprecated
  withPerformanceMonitoring
};
