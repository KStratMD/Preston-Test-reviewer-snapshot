import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { unifiedTemplateService } from '../services/UnifiedTemplateService';
import { UnifiedTemplate } from '../types/template.types';

export function createUnifiedTemplatesRouter(): Router {
  const router = Router();

  // Get full template library
  router.get('/library', asyncHandler(async (_req, res) => {
    const library = unifiedTemplateService.getLibrary();
    res.json(library);
  }));

  // Get all templates
  router.get('/', asyncHandler(async (req, res) => {
    const library = unifiedTemplateService.getLibrary();
    
    // Support filtering
    const { category, sourceSystem, targetSystem, tags, search } = req.query;
    
    if (search || category || sourceSystem || targetSystem || tags) {
      const results = unifiedTemplateService.searchTemplates(
        search as string || '',
        {
          category: category as string,
          sourceSystem: sourceSystem as string,
          targetSystem: targetSystem as string,
          tags: tags ? (tags as string).split(',') : undefined
        }
      );
      return res.json({ templates: results, total: results.length });
    }
    
    return res.json({ templates: library.templates, total: library.templates.length });
  }));

  // Get categories
  router.get('/categories', asyncHandler(async (_req, res) => {
    const library = unifiedTemplateService.getLibrary();
    return res.json({ categories: library.categories });
  }));

  // Get templates by category
  router.get('/category/:category', asyncHandler(async (req, res) => {
    const templates = unifiedTemplateService.getTemplatesByCategory(req.params.category || '');
    return res.json({ templates, total: templates.length });
  }));

  // Get single template by key
  router.get('/:key', asyncHandler(async (req, res) => {
    const template = unifiedTemplateService.getTemplate(req.params.key || '');
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }
    return res.json(template);
  }));

  // Create new template
  router.post('/', asyncHandler(async (req, res) => {
    try {
      const template = unifiedTemplateService.createTemplate(req.body);
      return res.status(201).json(template);
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      return res.status(400).json({ error: err.message });
    }
  }));

  // Update template
  router.put('/:key', asyncHandler(async (req, res) => {
    try {
      const template = unifiedTemplateService.updateTemplate(req.params.key || '', req.body);
      return res.json(template);
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      return res.status(400).json({ error: err.message });
    }
  }));

  // Delete template
  router.delete('/:key', asyncHandler(async (req, res) => {
    const success = unifiedTemplateService.deleteTemplate(req.params.key || '');
    if (!success) {
      return res.status(404).json({ error: 'Template not found or not deletable' });
    }
    return res.json({ success: true });
  }));

  // Export templates
  router.post('/export', asyncHandler(async (req, res) => {
    const { keys } = req.body;
    const templates = unifiedTemplateService.exportTemplates(keys);
    res.json({ templates });
  }));

  // Export all templates (download)
  router.get('/export/all', asyncHandler(async (_req, res) => {
    const templates = unifiedTemplateService.exportTemplates();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="templates-export.json"');
    res.send(JSON.stringify({ templates, version: '2.0.0' }, null, 2));
  }));

  // Import templates
  router.post('/import', asyncHandler(async (req, res) => {
    let templates: UnifiedTemplate[];
    
    if (Array.isArray(req.body)) {
      templates = req.body;
    } else if (req.body.templates && Array.isArray(req.body.templates)) {
      templates = req.body.templates;
    } else {
      return res.status(400).json({ error: 'Invalid import format' });
    }

    const result = unifiedTemplateService.importTemplates(templates);
    return res.json(result);
  }));

  // Search templates
  router.post('/search', asyncHandler(async (req, res) => {
    const { query, filters } = req.body;
    const results = unifiedTemplateService.searchTemplates(query, filters);
    res.json({ templates: results, total: results.length });
  }));

  // Clone template
  router.post('/:key/clone', asyncHandler(async (req, res) => {
    const sourceTemplate = unifiedTemplateService.getTemplate(req.params.key || '');
    if (!sourceTemplate) {
      return res.status(404).json({ error: 'Template not found' });
    }

    const { name, key } = req.body;
    const clonedTemplate = unifiedTemplateService.createTemplate({
      ...sourceTemplate,
      key: key || `${sourceTemplate.key}-copy-${Date.now()}`,
      name: name || `${sourceTemplate.name} (Copy)`,
      source: 'custom'
    });

    return res.status(201).json(clonedTemplate);
  }));

  // Get template statistics
  router.get('/stats/overview', asyncHandler(async (_req, res) => {
    const library = unifiedTemplateService.getLibrary();
    const stats = {
      total: library.templates.length,
      builtin: library.templates.filter(t => t.source === 'builtin').length,
      custom: library.templates.filter(t => t.source === 'custom').length,
      categories: library.categories.length,
      byCategory: library.categories.map(cat => ({
        category: cat.name,
        count: cat.templateCount || 0
      })),
      popularTemplates: library.templates
        .filter(t => t.metadata?.popularity)
        .sort((a, b) => (b.metadata?.popularity || 0) - (a.metadata?.popularity || 0))
        .slice(0, 5)
        .map(t => ({ key: t.key, name: t.name, popularity: t.metadata?.popularity }))
    };
    res.json(stats);
  }));

  // Migrate old template format
  router.post('/migrate', asyncHandler(async (req, res) => {
    const oldTemplate = req.body;
    const migratedTemplate = unifiedTemplateService.migrateOldTemplate(oldTemplate);
    res.json(migratedTemplate);
  }));

  return router;
}