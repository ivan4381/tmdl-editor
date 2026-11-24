// Collapsible category header for the sidebars (shared by both edit views).

import { h, fmt } from './dom.js';

/**
 * @param {{id:string, title:string, count:number, open:boolean, domId:string, onToggle:(open:boolean)=>void}} o
 * @returns {{head:HTMLElement, items:HTMLElement}}
 */
export function sideGroup(o) {
  const items = h('div', { class: 'side-group-items', id: o.domId, hidden: !o.open });
  const head = h('button', {
    type: 'button', class: 'side-group', dataset: { group: o.id }, 'aria-expanded': String(o.open), 'aria-controls': o.domId,
  }, h('span', { class: 'side-chevron', 'aria-hidden': 'true', text: '▸' }), h('span', { class: 'side-group-title', text: o.title }),
  h('span', { class: 'side-group-count', text: `(${fmt(o.count)})` }));
  head.addEventListener('click', () => {
    const nowOpen = items.hidden; // toggle without rebuilding the list (keeps the scroll position)
    items.hidden = !nowOpen;
    head.setAttribute('aria-expanded', String(nowOpen));
    o.onToggle(nowOpen);
  });
  return { head, items };
}
