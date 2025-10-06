import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Documentation Routes
 * @param {import("fastify").FastifyInstance} app
 * @param {*} _
 * @param {Function} done
 */
export const docsRoutes = (app, _, done) => {
  
  // Serve API documentation
  app.get('/docs', async (request, reply) => {
    try {
      // Read the markdown file
      const docsPath = join(__dirname, '../../API_DOCS.md');
      const markdownContent = readFileSync(docsPath, 'utf-8');
      
      // Convert markdown to HTML with accordion structure
      const htmlContent = markdownToAccordionHtml(markdownContent);
      
      // Send HTML response
      reply.type('text/html');
      return reply.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Pivy API Documentation</title>
          <style>
            * {
              box-sizing: border-box;
            }
            
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              line-height: 1.5;
              max-width: 1000px;
              margin: 0 auto;
              padding: 20px;
              background: #f8f9fa;
              color: #2c3e50;
            }
            
            .container {
              background: white;
              padding: 24px;
              border-radius: 12px;
              box-shadow: 0 4px 20px rgba(0,0,0,0.08);
            }
            
            h1 { 
              color: #2c3e50; 
              border-bottom: 3px solid #3498db; 
              padding-bottom: 12px;
              margin-bottom: 24px;
              font-size: 2em;
            }
            
            /* Accordion Styling */
            .accordion-section {
              margin: 8px 0;
              border: 1px solid #e1e8ed;
              border-radius: 8px;
              overflow: hidden;
              background: #ffffff;
              box-shadow: 0 2px 4px rgba(0,0,0,0.04);
            }
            
            .accordion-section.active {
              border-color: #3498db;
              box-shadow: 0 4px 8px rgba(52, 152, 219, 0.1);
            }
            
            .accordion-header {
              padding: 12px 18px;
              background: #f8f9fb;
              cursor: pointer;
              user-select: none;
              display: flex;
              align-items: center;
              gap: 10px;
              font-weight: 600;
              color: #2c3e50;
              border-bottom: 1px solid transparent;
              transition: all 0.2s ease;
              position: relative;
            }
            
            .accordion-header:hover {
              background: #e8f4fd;
              color: #1a73e8;
            }
            
            .accordion-section.active .accordion-header {
              border-bottom-color: #e1e8ed;
              background: #f0f7ff;
              color: #1a73e8;
            }
            
            .accordion-arrow {
              color: #666;
              font-size: 12px;
              transition: transform 0.2s ease;
              flex-shrink: 0;
            }
            
            .accordion-section.active .accordion-arrow {
              transform: rotate(90deg);
              color: #3498db;
            }
            
            .accordion-title {
              margin: 0;
              font-size: 1.2em;
              color: inherit;
            }
            
            .accordion-content {
              display: none;
              padding: 12px 20px;
              background: white;
              border-top: 1px solid #f0f2f5;
            }
            
            .accordion-section.active .accordion-content {
              display: block;
            }
            
            /* Endpoint styling */
            h3 {
              color: #34495e;
              margin: 12px 0 6px 0;
              padding: 4px 0;
              border-bottom: 1px solid #ecf0f1;
              font-size: 1.02em;
              font-weight: 600;
            }
            
            /* HTTP Method badges */
            .method {
              display: inline-block;
              padding: 4px 8px;
              border-radius: 4px;
              font-size: 0.75em;
              font-weight: bold;
              margin-right: 8px;
              text-transform: uppercase;
            }
            
            .method.get { background: #e8f5e8; color: #2e7d32; }
            .method.post { background: #fff3e0; color: #ef6c00; }
            .method.put { background: #e3f2fd; color: #1976d2; }
            .method.delete { background: #ffebee; color: #d32f2f; }
            
            .auth-required {
              color: #e74c3c;
              font-weight: bold;
              font-size: 1.1em;
            }
            
            /* Code styling */
            code {
              background: #f5f7fa;
              padding: 2px 6px;
              border-radius: 4px;
              font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
              font-size: 0.9em;
              color: #5c6ac4;
            }
            
            pre {
              background: #2d3748;
              color: #e2e8f0;
              padding: 16px;
              border-radius: 8px;
              overflow-x: auto;
              margin: 15px 0;
              font-size: 0.9em;
            }
            
            pre code {
              background: none;
              padding: 0;
              color: inherit;
            }
            
            /* List styling */
            ul {
              padding-left: 24px;
              margin: 6px 0 12px 0;
              background: #fafbfc;
              border-radius: 4px;
              padding: 8px 8px 8px 24px;
              border-left: 2px solid #e1e8ed;
            }
            
            li {
              margin: 2px 0;
              line-height: 1.3;
              font-size: 0.9em;
            }
            
            li strong {
              color: #2c3e50;
              font-weight: 600;
              font-size: 0.85em;
            }
            
            /* Strong text */
            strong {
              color: #2c3e50;
              font-weight: 600;
            }
            
            /* Section dividers */
            hr {
              display: none;
            }
            
            /* Reference section */
            .reference-section {
              margin-top: 32px;
              padding: 20px;
              background: #f8f9fa;
              border-radius: 8px;
              border-left: 4px solid #3498db;
            }
            
            .reference-section h2 {
              color: #2c3e50;
              margin-top: 0;
              font-size: 1.3em;
            }
            
            /* Responsive */
            @media (max-width: 768px) {
              body {
                padding: 10px;
              }
              
              .container {
                padding: 16px;
              }
              
              .accordion-header {
                padding: 10px 14px;
                gap: 8px;
              }
              
              .accordion-content {
                padding: 10px 14px;
              }
              
              ul {
                padding: 6px 6px 6px 20px;
                margin: 4px 0 8px 0;
              }
            }
          </style>
        </head>
        <body>
          <div class="container">
            ${htmlContent}
          </div>
          
          <script>
                          // Accordion functionality
              document.addEventListener('DOMContentLoaded', function() {
                const headers = document.querySelectorAll('.accordion-header');
                
                headers.forEach(header => {
                  header.addEventListener('click', function() {
                    const section = this.parentElement;
                    const isActive = section.classList.contains('active');
                    
                    // Close all sections
                    document.querySelectorAll('.accordion-section').forEach(s => {
                      s.classList.remove('active');
                    });
                    
                    // Open clicked section if it wasn't active
                    if (!isActive) {
                      section.classList.add('active');
                    }
                  });
                });
              });
          </script>
        </body>
        </html>
      `);
    } catch (error) {
      return reply.status(500).send({
        success: false,
        message: 'Error loading documentation',
        error: error.message
      });
    }
  });

  done();
};

// Convert markdown to accordion HTML
function markdownToAccordionHtml(markdown) {
  // First clean up the markdown by removing standalone dividers
  const cleanedMarkdown = markdown.replace(/^---$/gm, '');
  
  // Split content by sections
  const sections = cleanedMarkdown.split(/^## /gm).filter(section => section.trim());
  
  let html = '';
  
  sections.forEach((section, index) => {
    if (index === 0) {
      // Handle the title and intro
      const lines = section.split('\n');
      const title = lines[0].replace('# ', '');
      html += `<h1>${title}</h1>\n`;
      return;
    }
    
    const lines = section.split('\n').filter(line => line.trim() !== '');
    const sectionTitle = lines[0].trim();
    const sectionContent = lines.slice(1).join('\n');
    
    // Check if this is the Documentation Reference section
    if (sectionTitle === 'Documentation Reference') {
      html += '<div class="reference-section">';
      html += `<h2>${sectionTitle}</h2>`;
      html += processMarkdownContent(sectionContent);
      html += '</div>';
      return;
    }
    
    // Skip empty sections
    if (!sectionContent.trim()) {
      return;
    }
    
    // Create accordion section
    html += '<div class="accordion-section">';
    html += '<div class="accordion-header">';
    html += '<span class="accordion-arrow">▶</span>';
    html += `<h2 class="accordion-title">${sectionTitle}</h2>`;
    html += '</div>';
    html += '<div class="accordion-content">';
    html += processMarkdownContent(sectionContent);
    html += '</div>';
    html += '</div>';
  });
  
  return html;
}

// Process markdown content
function processMarkdownContent(content) {
  if (!content || !content.trim()) {
    return '';
  }
  
  // Clean content first
  const cleanContent = content
    .replace(/^---$/gm, '') // Remove any remaining dividers
    .trim();
  
  // Process markdown elements
  let processed = cleanContent
    // Headers
    .replace(/^### (.*$)/gm, '<h3>$1</h3>')
    
    // Code blocks
    .replace(/```json\n([\s\S]*?)\n```/g, '<pre><code>$1</code></pre>')
    .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
    
    // Inline code
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    
    // Bold and italic
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    
    // HTTP methods with proper classes
    .replace(/\bGET\b/g, '<span class="method get">GET</span>')
    .replace(/\bPOST\b/g, '<span class="method post">POST</span>')
    .replace(/\bPUT\b/g, '<span class="method put">PUT</span>')
    .replace(/\bDELETE\b/g, '<span class="method delete">DELETE</span>')
    
    // Lock emoji
    .replace(/🔒/g, '<span class="auth-required">🔒</span>');
  
  // Process lists properly
  const lines = processed.split('\n');
  const processedLines = [];
  let inList = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    if (line.startsWith('- ')) {
      if (!inList) {
        processedLines.push('<ul>');
        inList = true;
      }
      processedLines.push(`<li>${line.substring(2)}</li>`);
    } else {
      if (inList) {
        processedLines.push('</ul>');
        inList = false;
      }
      if (line) {
        processedLines.push(line);
      }
    }
  }
  
  // Close any open list
  if (inList) {
    processedLines.push('</ul>');
  }
  
  // Join lines and clean up
  return processedLines
    .filter(line => line.trim())
    .join('<br>')
    .replace(/<br><ul>/g, '<ul>')
    .replace(/<\/ul><br>/g, '</ul>')
    .replace(/<br><h3>/g, '<h3>')
    .replace(/<\/h3><br>/g, '</h3>')
    .replace(/<br><pre>/g, '<pre>')
    .replace(/<\/pre><br>/g, '</pre>')
    .replace(/<br><br>/g, '<br>')
    .replace(/^<br>|<br>$/g, '');
}