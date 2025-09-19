require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const puppeteer = require('puppeteer');
const nodemailer = require('nodemailer');
const helmet = require('helmet');
const morgan = require('morgan');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 80;

app.use(helmet());
app.use(bodyParser.json());
app.use(morgan('combined'));
app.use(cors());
app.options('*', cors());

app.post('/fetch-vf-arba-data', async (req, res) => {
  const { lat, lng, email } = req.body;
  try {
    const { partidas, partido, municipio } = await fetchArbaData(lat, lng);
    if (partidas && partidas.length) {
      await sendEmail(email, partidas, partido, municipio);
      res.send({ message: 'Email enviado con éxito', partidas: partidas.map(p => p.partida), partido });
    } else {
      res.status(500).send({ error: 'No se pudo obtener las partidas' });
    }
  } catch (error) {
    res.status(500).send({ error: 'Error procesando la solicitud' });
  }
});

async function fetchArbaData(lat, lng) {
  let browser;
  try {
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
    const page = await browser.newPage();
    await page.goto('https://carto.arba.gov.ar/cartoArba/', { waitUntil: 'networkidle2' });
    await delay(1000);
    await page.evaluate(() => { document.querySelectorAll('*').forEach(el => { el.onclick = null; el.onmousedown = null; }); });
    let buttonActivated = await page.evaluate(() => !!document.querySelector('.olControlInfoButtonItemActive.olButton[title="Información"]'));
    if (!buttonActivated) {
      await page.evaluate(() => {
        const button = document.querySelector('.olControlInfoButtonItemInactive.olButton[title="Información"]');
        if (button) {
          button.style.pointerEvents = 'auto';
          ['mousedown','mouseup','click'].forEach(ev => button.dispatchEvent(new MouseEvent(ev,{bubbles:true,cancelable:true,view:window})));
        }
      });
      await delay(1000);
      buttonActivated = await page.evaluate(() => !!document.querySelector('.olControlInfoButtonItemActive.olButton[title="Información"]'));
    }
    await page.type('#inputfindall', `${lat},${lng}`);
    await page.waitForSelector('#ui-id-1', { visible: true, timeout: 30000 });
    await page.click('#ui-id-1');
    await delay(5000);
    const dim = await page.evaluate(() => ({ w: document.documentElement.clientWidth, h: document.documentElement.clientHeight }));
    await page.mouse.click(dim.w / 2, dim.h / 2);
    await delay(10000);
    await page.waitForSelector('.panel.curva.panel-info .panel-body div', { visible: true, timeout: 60000 });
    await delay(3000);
    const partidas = await getAllPartidas(page);
    const partidoText = await page.evaluate(() => {
      const partidoDiv = Array.from(document.querySelectorAll('.panel.curva.panel-info .panel-body div')).find(div => div.textContent.includes('Partido:'));
      return partidoDiv ? partidoDiv.textContent.trim() : '';
    });
    const partidoNumeroMatch = partidoText.match(/Partido:\s*(\d+)/);
    const municipioMatch = partidoText.match(/\(([^)]+)\)/);
    const partido = partidoNumeroMatch ? partidoNumeroMatch[1] : '';
    const municipio = municipioMatch ? municipioMatch[1] : '';
    await browser.close();
    return { partidas, partido, municipio };
  } catch (e) {
    if (browser) await browser.close();
    throw e;
  }
}

async function getAllPartidas(page) {
  try { await page.waitForSelector('.table-pager', { visible: true, timeout: 4000 }); } catch {}
  const totalPages = await page.evaluate(() => {
    const el = document.querySelector('.table-pager .total-pages');
    return el ? parseInt(el.textContent.trim(), 10) : 1;
  });
  let all = [];
  for (let p = 1; p <= totalPages; p++) {
    const filas = await extractTableRows(page);
    all = all.concat(filas);
    if (p < totalPages) {
      await page.evaluate(() => {
        const nextBtn = document.querySelector('.btn.btn-primary.btn-sm.next-page');
        if (nextBtn && !nextBtn.classList.contains('disabled')) nextBtn.click();
      });
      await delay(2000);
    }
  }
  return all;
}

async function extractTableRows(page) {
  return page.evaluate(() => {
    const table = Array.from(document.querySelectorAll('table')).find(tbl =>
      Array.from(tbl.querySelectorAll('th')).some(th => th.textContent.includes('Partida'))
    );
    if (!table) return [];
    const rows = table.querySelectorAll('tbody tr');
    return Array.from(rows).map(row => {
      const tds = row.querySelectorAll('td');
      return {
        partida: tds[0] ? tds[0].textContent.trim() : '',
        supTerreno: tds[1] ? tds[1].textContent.trim() : '',
        sp: tds[2] ? tds[2].textContent.trim() : ''
      };
    }).filter(r => r.partida);
  });
}

async function sendEmail(email, partidas, partidoNumero, municipio) {
  const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const headerHtml =
    '<div style="padding:1rem;text-align:center;">' +
      '<img src="https://proprop.com.ar/wp-content/uploads/2025/09/catastro-min-min.jpg" alt="VF ARBA" style="max-width:100%;height:auto;display:block;margin:0 auto 1rem;">' +
      '<h2 style="margin:0 0 .5rem;font-family:Arial,Helvetica,sans-serif;">Resultados de tu consulta VF ARBA</h2>' +
      '<p style="margin:.25rem 0 1rem;font-family:Arial,Helvetica,sans-serif;">A continuación encontrarás la(s) partida(s) detectada(s) para la ubicación.</p>' +
    '</div>';
  const instructionsText =
    'Instrucciones:\n' +
    '1) Copiá el número de partida.\n' +
    '2) Hacé click en el botón "Consultar VF ARBA".\n' +
    '3) En la página de ARBA pegá el número y seguí los pasos.\n' +
    '4) Completá el captcha si corresponde y consultá.\n';
  const instructionsHtml =
    '<div style="text-align:left;font-family:Arial,Helvetica,sans-serif;">' +
      '<p style="margin:.5rem 0;"><strong>Instrucciones</strong></p>' +
      '<ol style="margin:.25rem 0 1rem 1.25rem;padding:0;">' +
        '<li>Copiá el número de partida.</li>' +
        '<li>Hacé click en el botón <em>"Consultar VF ARBA"</em>.</li>' +
        '<li>Pegá el número y seguí los pasos en el sitio.</li>' +
        '<li>Completá el captcha si corresponde y consultá.</li>' +
      '</ol>' +
    '</div>';
  const arbaLink = 'https://app.arba.gov.ar/Informacion/consultarValuacionesInit.do';
  const listItemsHtml = partidas.map(obj => {
    const partida = escapeHtml(obj.partida ?? '');
    const sp = escapeHtml(obj.sp || '');
    const spLine = sp ? `<div style="font-size:.9rem;color:#555;">Subparcela (PH): ${sp}</div>` : '';
    return (
      '<li style="margin:0 0 .75rem 0;display:flex;align-items:center;justify-content:space-between;gap:12px;">' +
        '<div style="text-align:left;font-family:Arial,Helvetica,sans-serif;">' +
          `<div><strong>Partida:</strong> ${partida}${partidoNumero ? ` <span style="color:#6b7280;">(Partido ${escapeHtml(partidoNumero)})</span>` : ''}</div>` +
          spLine +
        '</div>' +
        `<a href="${arbaLink}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:10px 14px;background:#0b5ed7;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;font-family:Arial,Helvetica,sans-serif;">Consultar VF ARBA</a>` +
      '</li>'
    );
  }).join('');
  const dataHtml =
    headerHtml +
    '<div style="padding:1rem;">' +
      instructionsHtml +
      '<ul style="list-style:none;margin:0;padding:0;">' + listItemsHtml + '</ul>' +
      '<hr style="margin:1rem 0;border:0;border-top:1px solid #e5e7eb;">' +
      `<p style="font-size:.9rem;color:#555;font-family:Arial,Helvetica,sans-serif;">Enlace directo a ARBA: <a href="${arbaLink}" target="_blank" rel="noopener noreferrer">Valuación Fiscal ARBA</a>${municipio ? ` — ${escapeHtml(municipio)}` : ''}</p>` +
      '<p style="font-size:.8rem;color:#777;font-style:italic;font-family:Arial,Helvetica,sans-serif;">Te llegó este correo porque solicitaste la valuación fiscal ARBA al servicio de consultas de ProProp.</p>' +
    '</div>';
  const linesText = partidas.map(obj => {
    const p = obj.partida ?? '';
    const sp = obj.sp ? ` | Subparcela (PH): ${obj.sp}` : '';
    return `Partida: ${p}${sp}${partidoNumero ? ` | Partido: ${partidoNumero}` : ''}`;
  }).join('\n');
  const dataText =
    instructionsText + '\n' + linesText + '\n\n' +
    `Ir a ARBA: ${arbaLink}\n\n` +
    'Te llegó este correo porque solicitaste la valuación fiscal ARBA al servicio de consultas de ProProp.';
  const transporter = nodemailer.createTransport({
    host: "smtp-relay.brevo.com",
    port: 465,
    secure: true,
    auth: { user: process.env.BREVO_USER, pass: process.env.BREVO_PASS }
  });
  const mailOptions = {
    from: '"PROPROP" <ricardo@proprop.com.ar>',
    to: email,
    bcc: 'info@proprop.com.ar',
    subject: "VF ARBA – Partida(s) detectada(s) para tu dirección",
    text: dataText,
    html: '<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:#fff;opacity:0;">Copiá la partida y consultá en ARBA en 2 pasos.</div>' + dataHtml
  };
  const info = await transporter.sendMail(mailOptions);
  return info && info.messageId ? info.messageId : null;
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

const server = app.listen(port, () => {});
server.setTimeout(180000);
