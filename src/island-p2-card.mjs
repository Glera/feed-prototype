/** Mount the one post-chest Island P2 prompt.
 *
 * Kept as a small DOM module so the production renderer can be exercised in a
 * focused browser without booting/playing an entire five-level series.
 */
export function mountIslandVisitAwardCard({
  parent,
  award,
  escapeHtml,
  onShown,
  onDecline,
  onAccept,
  onError,
}) {
  if (!parent || !award?.target || parent.querySelector('.isln-award')) return null;
  const target = award.target;
  const name = target.first_name || target.username || (target.is_bot ? 'Сосед-бот' : 'Новый остров');
  const initial = (name.trim()[0] || '?').toUpperCase();
  const avatar = target.photo_url
    ? `<img src="${escapeHtml(target.photo_url)}" alt="" draggable="false">`
    : `<span>${escapeHtml(initial)}</span>`;
  const puzzles = Math.max(0, Number(award.gift_preview?.puzzles) || 0);
  const card = document.createElement('section');
  card.className = 'isln-award';
  card.innerHTML =
    `<div class="isln-award__avatar${target.is_bot ? ' isln-award__avatar--bot' : ''}">${avatar}</div>` +
    '<div class="isln-award__copy">' +
    `<strong>${escapeHtml(name)}${target.is_bot ? ' 🤖' : ''}</strong>` +
    `<span>Зайди на остров — в домике может ждать +${puzzles} пазла</span>` +
    '</div>' +
    '<div class="isln-award__actions">' +
    '<button type="button" class="isln-award__later">Позже</button>' +
    '<button type="button" class="isln-award__go">Пойти</button>' +
    '</div>';
  parent.prepend(card);
  onShown?.();
  const stop = (event) => event.stopPropagation();
  card.addEventListener('pointerdown', stop);
  card.addEventListener('pointerup', stop);
  card.querySelector('.isln-award__later')?.addEventListener('click', (event) => {
    event.stopPropagation();
    const button = event.currentTarget;
    button.disabled = true;
    Promise.resolve(onDecline?.())
      .catch(() => null)
      .finally(() => card.remove());
  });
  card.querySelector('.isln-award__go')?.addEventListener('click', (event) => {
    event.stopPropagation();
    const button = event.currentTarget;
    button.disabled = true;
    Promise.resolve(onAccept?.())
      .then(() => card.remove())
      .catch((error) => {
        button.disabled = false;
        onError?.(error);
      });
  });
  return card;
}
