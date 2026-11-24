// Hash routing. Eleven places to be:
//   #/            the front page: the same as #/agents
//   #/p/<slug>    one project's chat
//   #/j/<id>      a brand-new job, until the host names its project
//   #/new         start a project
//   #/agents      every agent at once: slots, what's running, what's waiting
//   #/house       your smart home hub, room by room
//   #/ask         your own assistant — the newest conversation
//   #/ask/<id>    one conversation with it
//   #/field       field reports: the sites, and what each needs
//   #/field/<id>  one site, its reports, and filing a new one
//   #/outbox      what this phone is still waiting to send
//   #/projects    everything you have, and where each one is live
//   #/ideas       everything worth building next, read off your own work

/** Mutated in place so importers always see the current route. */
export const route = { view: 'agents', slug: null, jobId: null, chatId: null, siteId: null };

const at = (view, rest = {}) => ({
  view, slug: null, jobId: null, chatId: null, siteId: null, ...rest,
});

export function readHash() {
  const h = location.hash.replace(/^#\/?/, '');
  if (h.startsWith('p/')) return at('project', { slug: decodeURIComponent(h.slice(2)) });
  if (h.startsWith('j/')) return at('pending', { jobId: h.slice(2) });
  if (h.startsWith('ask/')) return at('ask', { chatId: decodeURIComponent(h.slice(4)) });
  if (h === 'ask') return at('ask');
  if (h === 'house') return at('house');
  if (h.startsWith('field/')) return at('site', { siteId: decodeURIComponent(h.slice(6)) });
  if (h === 'field') return at('field');
  if (h === 'outbox') return at('outbox');
  if (h === 'new') return at('new');
  if (h === 'ideas') return at('ideas');
  if (h === 'projects') return at('projects');
  // `#/`, `#/agents`, and anything this app no longer has a page for — an old
  // bookmark to the home screen, say — all land on what is happening now.
  return at('agents');
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
export const askHref = (id) => (id ? `#/ask/${encodeURIComponent(id)}` : '#/ask');
export const siteHref = (id) => `#/field/${encodeURIComponent(id ?? '')}`;

export function initRouter(onChange) {
  syncRoute();
  window.addEventListener('hashchange', () => { syncRoute(); onChange(route); });
}
