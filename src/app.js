require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const puppeteer = require('puppeteer');
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
  const { lat, lng, email, address } = req.body;

  try {
    const { partidas, partido } = await fetchArbaData(lat, lng);

    if (!partidas || !partidas.length || !partido) {
      return res.status(500).send({
        success: false,
        service: 'vf_arba',
        error: 'No se pudo obtener las partidas o el partido',
        email,
        address,
        lat,
        lng
      });
    }

    const partidoNumeroMatch = partido.match(/Partido:\s*(\d+)/);
    const municipioMatch = partido.match(/\(([^)]+)\)/);
    const partidoNumero = partidoNumeroMatch ? partidoNumeroMatch[1] : '';
    const municipio = municipioMatch ? municipioMatch[1] : '';
    const arbaLink = 'https://app.arba.gov.ar/Informacion/consultarValuacionesInit.do';
    const prefillBase = 'https://app.arba.gov.ar/Informacion/consultarValuacionesInit.do';

    return res.send({
      success: true,
      service: 'vf_arba',
      message: 'Datos VF ARBA obtenidos correctamente',
      partidas,
      partido: partidoNumero,
      municipio,
      links: {
        consulta: arbaLink,
        prefillBase
      },
      email,
      address,
      lat,
      lng
    });
  } catch (error) {
    return res.status(500).send({
      success: false,
      service: 'vf_arba',
      error: 'Error procesando la solicitud',
      details: error.message || String(error),
      email,
      address,
      lat,
      lng
    });
  }
});

async function fetchArbaData(lat, lng) {
  let browser;

  try {
    const launchOptions = {
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    };

    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    browser = await puppeteer.launch(launchOptions);
    const page = await browser.newPage();

    await page.goto('https://carto.arba.gov.ar/cartoArba/', { waitUntil: 'networkidle2' });
    await delay(1000);

    await page.evaluate(() => {
      document.querySelectorAll('*').forEach(el => {
        el.onclick = null;
        el.onmousedown = null;
      });
    });

    let buttonActivated = await page.evaluate(() =>
      !!document.querySelector('.olControlInfoButtonItemActive.olButton[title="Información"]')
    );

    if (!buttonActivated) {
      await page.evaluate(() => {
        const btn = document.querySelector('.olControlInfoButtonItemInactive.olButton[title="Información"]');
        if (btn) {
          btn.style.pointerEvents = 'auto';
          ['mousedown', 'mouseup', 'click'].forEach(ev => btn.dispatchEvent(new MouseEvent(ev, {
            bubbles: true,
            cancelable: true,
            view: window
          })));
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

    const dim = await page.evaluate(() => ({
      w: document.documentElement.clientWidth,
      h: document.documentElement.clientHeight
    }));

    await page.mouse.click(dim.w / 2, dim.h / 2);

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
  } catch (error) {
    if (browser) await browser.close();
    throw error;
  }
}

async function getAllPartidas(page) {
  try {
    await page.waitForSelector('.table-pager', { visible: true, timeout: 4000 });
  } catch {}

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

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const server = app.listen(port, () => {});
server.setTimeout(300000);
