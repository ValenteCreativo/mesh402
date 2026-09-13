const form = document.querySelector('form');
form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    const body = new URLSearchParams(new FormData(form));
    const response = await fetch(form.action, { method: 'POST', body, headers: { Accept: 'application/json' } });
    form.reset();
    if (!response.ok) throw new Error('Operator authorization failed. Check the credential or wait before trying again.');
    location.assign('/');
  } catch (error) { document.querySelector('#result').textContent = error.message; }
  finally { button.disabled = false; }
});
