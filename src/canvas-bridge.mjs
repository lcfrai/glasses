// Serialized into the opaque-origin preview. No host execution of candidate code.
export function canvasBridge() {
  const root = document.querySelector('[data-glasses-root]');
  let enabled = false, selected = null;
  const marker = document.createElement('div');
  marker.setAttribute('aria-hidden', 'true');
  marker.style.cssText = 'display:none;position:fixed;pointer-events:none;border:2px solid #2449ed;background:#2449ed09;z-index:2147483647';
  document.body.append(marker);
  function mark(element) {
    selected = element;
    const rect = element?.getBoundingClientRect();
    marker.style.display = rect && enabled ? 'block' : 'none';
    if (rect) Object.assign(marker.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  }
  function selector(element) {
    const path = [];
    while (element && element !== root && path.length < 16) {
      path.unshift(`:nth-child(${Array.prototype.indexOf.call(element.parentElement.children, element) + 1})`);
      element = element.parentElement;
    }
    return element === root && path.length ? '[data-glasses-root] > ' + path.join(' > ') : null;
  }
  window.addEventListener('message', event => {
    if (event.source !== parent || event.data?.type !== 'glasses:selection-mode') return;
    enabled = event.data.enabled === true;
    if (typeof event.data.selector === 'string' && /^\[data-glasses-root\](?: > :nth-child\([1-9]\d{0,3}\)){1,16}$/.test(event.data.selector)) selected = document.querySelector(event.data.selector);
    root.style.cursor = enabled ? 'crosshair' : '';
    mark(selected);
  });
  document.addEventListener('click', event => {
    if (!enabled || !(event.target instanceof HTMLElement) || !root.contains(event.target) || event.target === root) return;
    const path = selector(event.target);
    if (!path) return;
    event.preventDefault(); event.stopImmediatePropagation();
    mark(event.target);
    const computed = getComputedStyle(event.target);
    const styles = {};
    for (const property of ['color', 'backgroundColor', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'padding', 'margin', 'borderRadius', 'gap']) styles[property] = computed[property];
    parent.postMessage({ type: 'glasses:selection', selector: path, tag: event.target.tagName.toLowerCase(), text: (event.target.textContent || '').trim().slice(0, 100), styles }, '*');
  }, true);
  window.addEventListener('scroll', () => mark(selected), true);
  window.addEventListener('resize', () => mark(selected));
  parent.postMessage({ type: 'glasses:canvas-ready' }, '*');
}
