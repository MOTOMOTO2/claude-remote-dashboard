// Hash routing. Seven places to be:
//   #/            home
//   #/p/<slug>    one project's chat
//   #/j/<id>      a brand-new job, until the host names its project
//   #/new         start a project
//   #/agents      every agent at once: slots, what's running, what's waiting
//   #/projects    everything you have, and where each one is live
//   #/ideas       everything worth building next, read off your own work

/** Mutated in place so importers always see the current route. */
export const route = { view: 'home', slug: null, jobId: null };

export function readHash() {
  const h = location.hash.replace(/^#\/?/, '');
  if (h.startsWith('p/')) return { view: 'project', slug: decodeURIComponent(h.slice(2)), jobId: null };
  if (h.startsWith('j/')) return { view: 'pending', slug: null, jobId: h.slice(2) };
  if (h === 'new') return { view: 'new', slug: null, jobId: null };
  if (h === 'ideas') return { view: 'ideas', slug: null, jobId: null };
  if (h === 'agents') return { view: 'agents', slug: null, jobId: null };
  if (h === 'projects') return { view: 'projects', slug: null, jobId: null };
  return { view: 'home', slug: null, jobId: null };
}

export function syncRoute() {
  Object.assign(route, readHash());
  return route;
}

export const go = (hash) => {
  if (location.hash === hash) return;
  location.hash = hash;
};

export const projectHref = (slug) => `#/p/${encodeURIComponent(slug ?? '')}`;

export function initRouter(onChange) {
  syncRoute();
  window.addEventListener('hashchange', () => { syncRoute(); onChange(route); });
}
