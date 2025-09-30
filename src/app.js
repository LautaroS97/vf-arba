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
    const { partidas, partido } = await fetchArbaData(lat, lng);
    if (!partidas || !partidas.length || !partido) {
      return res.status(500).send({ error: 'No se pudo obtener las partidas o el partido' });
    }

    const partidoNumeroMatch = partido.match(/Partido:\s*(\d+)/);
    const municipioMatch = partido.match(/\(([^)]+)\)/);
    const partidoNumero = partidoNumeroMatch ? partidoNumeroMatch[1] : '';
    const municipio = municipioMatch ? municipioMatch[1] : '';

    try {
      await sendEmail(email, partidas, partidoNumero, municipio);
      return res.send({
        message: 'Email enviado con éxito',
        partidas: partidas.map(p => p.partida),
        partido: partidoNumero
      });
    } catch (e) {
      return res.status(200).send({
        message: 'Partidas obtenidas, pero falló el envío de email',
        partidas: partidas.map(p => p.partida),
        partido: partidoNumero,
        emailError: e.message || String(e)
      });
    }
  } catch (error) {
    return res.status(500).send({ error: 'Error procesando la solicitud', details: error.message || String(error) });
  }
});

async function fetchArbaData(lat, lng) {
  let browser;
  try {
    const launchOptions = {
      headless: 'new',
      args: ['--no-sandbox','--disable-setuid-sandbox']
    };
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    browser = await puppeteer.launch(launchOptions);
    const page = await browser.newPage();

    await page.goto('https://carto.arba.gov.ar/cartoArba/', { waitUntil: 'networkidle2' });
    await delay(1000);

    await page.evaluate(() => {
      document.querySelectorAll('*').forEach(el => { el.onclick = null; el.onmousedown = null; });
    });

    let buttonActivated = await page.evaluate(() =>
      !!document.querySelector('.olControlInfoButtonItemActive.olButton[title="Información"]')
    );
    if (!buttonActivated) {
      await page.evaluate(() => {
        const btn = document.querySelector('.olControlInfoButtonItemInactive.olButton[title="Información"]');
        if (btn) {
          btn.style.pointerEvents = 'auto';
          ['mousedown','mouseup','click'].forEach(ev => btn.dispatchEvent(new MouseEvent(ev,{bubbles:true,cancelable:true,view:window})));
        }
      });
      await delay(1000);
    }

    await page.type('#inputfindall', `${lat},${lng}`);

    const hasSuggestion = await page.$('#ui-id-1');
    if (hasSuggestion) {
      await page.waitForSelector('#ui-id-1', { visible: true, timeout: 30000 });
      await page.click('#ui-id-1');
    } else {
      await page.keyboard.press('Enter');
    }

    await delay(5000);

    const dim = await page.evaluate(() => ({ w: document.documentElement.clientWidth, h: document.documentElement.clientHeight }));
    await page.mouse.click(dim.w/2, dim.h/2);

    await delay(10000);
    await page.waitForSelector('.panel.curva.panel-info .panel-body div', { visible: true, timeout: 60000 });
    await delay(3000);

    const partidas = await getAllPartidas(page);
    const partido = await page.evaluate(() => {
      const partidoDiv = Array.from(document.querySelectorAll('.panel.curva.panel-info .panel-body div'))
        .find(div => div.textContent.includes('Partido:'));
      return partidoDiv ? partidoDiv.textContent.trim() : '';
    });

    await browser.close();
    return { partidas, partido };
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
  const transporter = nodemailer.createTransport({
    host: "smtp-relay.brevo.com",
    port: 465,
    secure: true,
    auth: { user: process.env.BREVO_USER, pass: process.env.BREVO_PASS },
    tls: { rejectUnauthorized: false },
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 10000
  });

  const arbaLink = 'https://app.arba.gov.ar/Informacion/consultarValuacionesInit.do';
  const prefillBase = 'https://app.arba.gov.ar/Informacion/consultarValuacionesInit.do';

  const listHtml = partidas.map(obj => {
    const sp = obj.sp ? `<div style="font-size:.9rem;color:#555;">Subparcela (PH): ${obj.sp}</div>` : '';
    const prefillUrl = partidoNumero
      ? `${prefillBase}?partido=${encodeURIComponent(partidoNumero)}&partida=${encodeURIComponent(obj.partida)}`
      : `${prefillBase}?partida=${encodeURIComponent(obj.partida)}`;
    const header = partidoNumero
      ? `<div><strong>Partido:</strong> ${partidoNumero} — <strong>Partida:</strong> ${obj.partida}</div>`
      : `<div><strong>Partida:</strong> ${obj.partida}</div>`;
    return `
      <li style="margin:0 0 1rem 0;padding:.5rem 0;border-bottom:1px solid #e5e7eb;list-style:none;">
        <div style="text-align:left;font-family:Arial,Helvetica,sans-serif;">
          ${header}
          ${sp}
        </div>
        <div style="text-align:center;margin-top:.5rem;">
          <a href="${prefillUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:10px 14px;background:#0b5ed7;color:#fff;text-decoration:none;border-radius:6px;font-weight:700;font-family:Arial,Helvetica,sans-serif;">Consultar VF ARBA</a>
        </div>
      </li>`;
  }).join('');

  const html = `
    <div style="padding:1rem;text-align:center;">
      <img src="https://proprop.com.ar/wp-content/uploads/2025/09/catastro-min-min.jpg" alt="VF ARBA" style="max-width:100%;height:auto;display:block;margin:0 auto 1rem;">
      <h2 style="margin:0 0 .5rem;font-family:Arial,Helvetica,sans-serif;">Resultados de tu consulta VF ARBA</h2>
      <p style="margin:.25rem 0 1rem;font-family:Arial,Helvetica,sans-serif;">A continuación encontrarás la(s) partida(s) detectada(s).</p>
    </div>
    <div style="padding:1rem;">
      <div style="text-align:left;font-family:Arial,Helvetica,sans-serif;">
        <p style="margin:.5rem 0;"><strong>Instrucciones</strong></p>
        <ol style="margin:.25rem 0 1rem 1.25rem;padding:0;">
          <li>Copiá <strong>Partido</strong> y <strong>Partida</strong>.</li>
          <li>Hacé clic en “Consultar VF ARBA”.</li>
          <li>Pegá los datos en el sitio y seguí los pasos.</li>
          <li>Completá el captcha si corresponde.</li>
        </ol>
      </div>
      <ul style="margin:0;padding:0;">
        ${listHtml}
      </ul>
      <hr style="margin:1rem 0;border:0;border-top:1px solid #e5e7eb;">
      <p style="font-size:.9rem;color:#555;font-family:Arial,Helvetica,sans-serif;">Enlace directo: <a href="${arbaLink}" target="_blank" rel="noopener noreferrer">Valuación Fiscal ARBA</a>${municipio ? ` — ${municipio}` : ''}</p>
    </div>`;

  const textItems = partidas.map(o => {
    const prefillUrl = partidoNumero
      ? `${prefillBase}?partido=${partidoNumero}&partida=${o.partida}`
      : `${prefillBase}?partida=${o.partida}`;
    return partidoNumero
      ? `Partido: ${partidoNumero} — Partida: ${o.partida} | Prellenado: ${prefillUrl}`
      : `Partida: ${o.partida} | Prellenado: ${prefillUrl}`;
  }).join('\n');

  await transporter.sendMail({
    from: '"PROPROP" <ricardo@proprop.com.ar>',
    to: email,
    bcc: 'info@proprop.com.ar',
    subject: "VF ARBA – Partidos y Partidas detectados",
    text: `${textItems}\nNo prellenado: ${arbaLink}${municipio ? ` — ${municipio}` : ''}`,
    html
  });
}

function delay(ms){ return new Promise(r => setTimeout(r, ms)); }

const server = app.listen(port, () => {});
server.setTimeout(300000);
