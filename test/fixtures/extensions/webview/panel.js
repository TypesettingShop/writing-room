const output = document.getElementById('output');
const count = document.getElementById('count');
const messages = [];
let value = 0;
document.querySelector('button').addEventListener('click', () => {
  count.textContent = String(++value);
});
window.addEventListener('message', ({ data }) => {
  if (typeof data.value === 'number') {
    messages.push(data.value);
    output.textContent = messages.join(',');
  } else if (typeof data.text === 'string') {
    output.textContent = data.text;
  }
});
