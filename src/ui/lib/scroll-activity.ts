/** Shared by every renderer entry point; capture includes nested plugin scrollers. */
const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>();
document.addEventListener("scroll", event => {
  const element = event.target === document ? document.documentElement : event.target;
  if (!(element instanceof Element)) return;
  element.setAttribute("data-scroll-active", "");
  clearTimeout(timers.get(element));
  timers.set(element, setTimeout(() => {
    element.removeAttribute("data-scroll-active");
    timers.delete(element);
  }, 700));
}, true);
