const errorEl = document.getElementById('error');

document.querySelectorAll('button[data-mode]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const buttons = document.querySelectorAll('button');
    buttons.forEach((b) => (b.disabled = true));
    errorEl.hidden = true;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'start', mode: btn.dataset.mode });
      if (!res?.ok) throw new Error(res?.error || '알 수 없는 오류');
      window.close();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      buttons.forEach((b) => (b.disabled = false));
    }
  });
});
