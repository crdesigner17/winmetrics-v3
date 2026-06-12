#!/usr/bin/env node
'use strict';

/*
 * Compatibility entry point kept for workflows and npm scripts that still call
 * frontend/jobs/pipeline_v1.js. The full implementation lives in
 * generate_predictions.js, which accepts the same runtime flags used here:
 * --date, --force, --only-new, --dry-run, --days, --limit.
 */
require('./generate_predictions.js');
