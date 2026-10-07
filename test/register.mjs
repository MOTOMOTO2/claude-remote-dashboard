// Redirects the Supabase CDN import to a local fake, so the app can be
// booted in Node exactly as the browser loads it — no code changes, no
// dependency injection seam that only exists for tests.
import { register } from 'node:module';

register('./loader.mjs', import.meta.url);
