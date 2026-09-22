'use strict';

// Corre como máximo `n` jobs a la vez y encola el resto. Renderizar es pesado para la CPU
// (canvas + ffmpeg), así que una API que recibe pedidos de varios clientes (un bot, una web,
// varios usuarios a la vez) necesita esto, si no intentaría renderizar todo en paralelo y
// ahogaría la máquina.
function createLimiter(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

module.exports = { createLimiter };
