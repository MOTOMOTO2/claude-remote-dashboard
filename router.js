// Hash routing. Nine places to be:
//   #/            home
//   #/p/<slug>    one project's chat
//   #/j/<id>      a brand-new job, until the host names its project
//   #/new         start a project
//   #/agents      every agent at once: slots, what's running, what's waiting
//   #/house       your smart home hub, room by room
//   #/ask         your own assistant — the newest conversation
//   #/ask/<id>    one conversation with it
//   #/projects    everything you have, and where each one is live
//   #/ideas       everything worth building next, read off your own work

/** Mutated in place so importers always see the current route. */
export const route = { view: 'home', slug: null, jobId: null, chatId: null };

const at = (view, rest = {}) => ({ view, slug: null, jobId: null, chatId: null, ...rest });

export function readHash() {
  const h = location.hash.replace(/^#\/?/, '');
  if (h.startsWith('p/')) return at('project', { slug: decodeURIComponent(h.slice(2)) });
  if (h.startsWith('j/')) return at('pending', { jobId: h.slice(2) });
  if (h.startsWith('ask/')) return at('ask', { chatId: decodeURIComponent(h.slice(4)) });
  if (h === 'ask') return at('ask');
  if (h === 'house') return at('house');
  if (h === 'new') return at('new');
  if (h === 'ideas') return at('ideas');
  if (h === 'agents') return at('agents');
  if (h === 'projects') return at('projects');
  return at('home');
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

export function initRouter(onChange) {
  syncRoute();
  window.addEventListener('hashchange', () => { syncRoute(); onChange(route); });
}
