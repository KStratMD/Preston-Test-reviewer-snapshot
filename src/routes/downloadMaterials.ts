import { Router, Request, Response } from 'express';
import archiver from 'archiver';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/Logger';

const router = Router();

/**
 * Download all strategic materials as a zip file
 * GET /api/download/strategic-materials
 */
router.get('/strategic-materials', (req: Request, res: Response) => {
    try {
        const date = new Date().toISOString().split('T')[0];
        const filename = `Squire-Integration-Hub-Strategic-Materials-${date}.zip`;
        
        // Set response headers
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        
        // Create archive
        const archive = archiver('zip', {
            zlib: { level: 9 } // Best compression
        });
        
        // Handle archive errors
        archive.on('error', (err) => {
            logger.error('Archive error:', err);
            res.status(500).send('Error creating zip file');
        });
        
        // Pipe archive to response
        archive.pipe(res);
        
        // Add README file
        const readmeContent = [
            '# Squire Integration Hub - Strategic Business Materials',
            '',
            '## Package Contents',
            '',
            'This package contains all strategic business materials for the Squire Integration Hub expansion opportunity.',
            '',
            '### Interactive Presentations',
            '- **strategic-presentation.html** - 12-slide executive presentation (open in web browser)',
            '',
            '### Strategic Documents',
            '- **SQUIRE_BUSINESS_CASE.md** - Comprehensive business case with market analysis, revenue model, competitive strategy, and customer value proposition',
            '- **SuiteCentral_Evolved_The_Integration_Advantage.md** - Strategic vision and transformation roadmap',
            '- **IMPROVEMENTS_SUMMARY.md** - Technical capabilities and implementation analysis (archived)',
            '',
            '### Executive Package v2',
            '- **executive-hub.html** - Executive navigation hub (open in web browser)',
            '- **01-EXECUTIVE-SUMMARY.html** - Executive summary presentation',
            '- **MINDMAP-ARCHITECTURE-STANDALONE.html** - Architecture visualization',
            '',
            '## How to Use',
            '',
            '1. **For Executive Presentations**: Open 01-EXECUTIVE-SUMMARY.html in any web browser',
            '2. **For Strategy Exploration**: Open MINDMAP-ARCHITECTURE-STANDALONE.html in any web browser',
            '3. **For Detailed Analysis**: Read the markdown (.md) files in any text editor or markdown viewer',
            '4. **For Interactive Demo**: Open executive-hub.html in any web browser',
            '',
            '## Key Insights',
            '',
            '- **$20.7M additional revenue** opportunity by Year 5 (Conservative)',
            '- **192% ROI** over 3 years with $2.85M initial investment',
            '- **Expansion** (not replacement) of existing SuiteCentral business',
            '- **40-50% expected upsell rate** from existing 200+ customers',
            '',
            '## Next Steps',
            '',
            '1. Review the strategic presentation for executive overview',
            '2. Explore the mindmap for comprehensive strategy visualization',
            '3. Read the detailed business case documents',
            '4. Present findings to leadership team for decision',
            '',
            '---',
            '',
            `**Generated**: ${date}`,
            '**Package**: Squire Integration Hub Strategic Materials v1.0',
            '**Contact**: Squire Strategic Planning Team'
        ].join('\n');
        
        archive.append(readmeContent, { name: 'README.txt' });
        
        // Define files to include
        const publicDir = path.join(process.cwd(), 'public');
        const rootDir = process.cwd();
        
        const files = [
            // Strategic documents
            { path: path.join(rootDir, 'SQUIRE_BUSINESS_CASE.md'), name: 'SQUIRE_BUSINESS_CASE.md' },
            { path: path.join(rootDir, 'docs', 'SuiteCentral_Evolved_The_Integration_Advantage.md'), name: 'SuiteCentral_Evolved_The_Integration_Advantage.md' },
            { path: path.join(rootDir, 'docs', 'archive', 'IMPROVEMENTS_SUMMARY.md'), name: 'IMPROVEMENTS_SUMMARY.md' },

            // Interactive presentations (v2 package)
            { path: path.join(publicDir, 'strategic-presentation.html'), name: 'strategic-presentation.html' },
            { path: path.join(publicDir, 'executive', 'executive-hub.html'), name: 'executive-hub.html' },
            { path: path.join(publicDir, 'Squire-Executive-Package-v2', '01-EXECUTIVE-SUMMARY.html'), name: '01-EXECUTIVE-SUMMARY.html' },
            { path: path.join(publicDir, 'Squire-Executive-Package-v2', 'MINDMAP-ARCHITECTURE-STANDALONE.html'), name: 'MINDMAP-ARCHITECTURE-STANDALONE.html' }
        ];
        
        // Add files to archive
        files.forEach(({ path: filePath, name }) => {
            if (fs.existsSync(filePath)) {
                archive.file(filePath, { name });
            } else {
                logger.warn(`File not found: ${filePath}`);
            }
        });
        
        // Finalize the archive
        archive.finalize();
        
    } catch (error) {
        logger.error('Error generating download:', error);
        res.status(500).json({ error: 'Failed to generate download package' });
    }
});

export default router;