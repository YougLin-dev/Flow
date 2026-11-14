/**
 * A view whose own wheel must not reach the page: a multiline field, which
 * scrolls itself natively, or an open menu. A listener around such a view
 * only observes the wheel — NSH still calls it while the field scrolls — so
 * the page root would zoom the canvas at the same time. The view listens
 * itself instead, which is how NSH decides a wheel's owner, and this handler
 * deliberately does nothing.
 */
export const keepsWheel = (): void => undefined;
