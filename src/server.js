const express = require('express')
const cors = require('cors')
const fetch = require('node-fetch')
const ffmpeg = require('fluent-ffmpeg')
const ffmpegStatic = require('ffmpeg-static')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { promisify } = require('util')
const stream = require('stream')
const pipeline = promisify(stream.pipeline)

// Usa ffmpeg-static se não tiver ffmpeg no sistema
ffmpeg.setFfmpegPath(ffmpegStatic)

const app = express()
const PORT = process.env.PORT || 3000

app.use(cors())
app.use(express.json())
app.use(express.static(path.join(__dirname, '../public')))

// ── UTILITÁRIOS ──────────────────────────────────────────

function isShopeeUrl(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase()
    return (
      hostname.includes('shopee.com.br') ||
      hostname.includes('shp.ee') ||
      hostname.includes('sv.shopee')
    )
  } catch {
    return false
  }
}

async function expandUrl(url) {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
      }
    })
    return res.url || url
  } catch {
    return url
  }
}

async function extractVideoUrl(pageUrl) {
  try {
    const res = await fetch(pageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        'Referer': 'https://shopee.com.br/'
      }
    })
    const html = await res.text()

    const patterns = [
      /https?:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*/g,
      /"video_url"\s*:\s*"([^"]+)"/g,
      /property="og:video"\s+content="([^"]+)"/g,
      /property="og:video:url"\s+content="([^"]+)"/g,
      /https?:\/\/cf\.shopee\.com\.br\/file\/[^"'\s<>]+/g,
    ]

    const found = new Set()
    for (const pattern of patterns) {
      const regex = new RegExp(pattern.source, pattern.flags)
      let match
      while ((match = regex.exec(html)) !== null) {
        const url = (match[1] || match[0])
          .replace(/\\u002F/g, '/')
          .replace(/\\/g, '')
          .replace(/&amp;/g, '&')
        if (url && url.includes('.mp4')) found.add(url)
      }
    }

    if (found.size > 0) {
      const urls = [...found]
      const cdnUrl = urls.find(u => u.includes('cf.shopee') || u.includes('akamai'))
      return cdnUrl || urls[0]
    }
    return null
  } catch {
    return null
  }
}

// ── LIMPEZA DE METADADOS ──────────────────────────────────
// Edita os atoms MP4 diretamente para remover handler_name e encoder
function cleanMetadata(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        '-map_metadata -1',      // Remove TODOS os metadados globais
        '-map_chapters -1',      // Remove capítulos
        '-fflags +bitexact',     // Modo determinístico sem timestamps
        '-c:v copy',             // Copia vídeo sem reencoder (rápido)
        '-c:a copy',             // Copia áudio sem reencoder (rápido)
        '-movflags +faststart',  // Otimiza para streaming
        // Limpa metadados das streams
        '-metadata:s:v:0 handler_name=',
        '-metadata:s:v:0 vendor_id=',
        '-metadata:s:v:0 encoder=',
        '-metadata:s:a:0 handler_name=',
        '-metadata:s:a:0 vendor_id=',
        '-metadata:s:a:0 encoder=',
      ])
      .save(outputPath)
      .on('end', resolve)
      .on('error', reject)
  })
}

// ── ROTAS DA API ──────────────────────────────────────────

// POST /api/process — extrai URL do vídeo
app.post('/api/process', async (req, res) => {
  try {
    const { url } = req.body

    if (!url || !isShopeeUrl(url)) {
      return res.status(400).json({ error: 'Link inválido. Use um link de vídeo da Shopee.' })
    }

    const expandedUrl = await expandUrl(url)
    const videoUrl = await extractVideoUrl(expandedUrl)

    if (!videoUrl) {
      return res.status(404).json({
        error: 'Não foi possível extrair o vídeo. Tente com o link direto do vídeo no app da Shopee.'
      })
    }

    res.json({ videoUrl, success: true })
  } catch (err) {
    res.status(500).json({ error: 'Erro interno. Tente novamente.' })
  }
})

// GET /api/download — baixa, limpa metadados e entrega o arquivo
app.get('/api/download', async (req, res) => {
  const { url } = req.query

  if (!url) {
    return res.status(400).json({ error: 'URL não fornecida' })
  }

  let inputPath = null
  let outputPath = null

  try {
    // 1. Baixa o vídeo original para arquivo temporário
    const tmpDir = os.tmpdir()
    const id = Date.now() + '_' + Math.random().toString(36).slice(2)
    inputPath = path.join(tmpDir, `input_${id}.mp4`)
    outputPath = path.join(tmpDir, `clean_${id}.mp4`)

    const videoRes = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
        'Referer': 'https://shopee.com.br/'
      }
    })

    if (!videoRes.ok) throw new Error('Falha ao baixar vídeo da Shopee')

    // Salva temporariamente
    await pipeline(videoRes.body, fs.createWriteStream(inputPath))

    // 2. Limpa os metadados com ffmpeg
    await cleanMetadata(inputPath, outputPath)

    // 3. Envia o arquivo limpo
    const filename = `shopeeclip-${Date.now()}.mp4`
    res.setHeader('Content-Type', 'video/mp4')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.setHeader('Cache-Control', 'no-store')

    const readStream = fs.createReadStream(outputPath)
    readStream.pipe(res)

    // Limpa arquivos temporários após envio
    readStream.on('end', () => {
      fs.unlink(inputPath, () => {})
      fs.unlink(outputPath, () => {})
    })

  } catch (err) {
    // Limpa arquivos temporários em caso de erro
    if (inputPath) fs.unlink(inputPath, () => {})
    if (outputPath) fs.unlink(outputPath, () => {})
    res.status(500).json({ error: 'Erro ao processar vídeo. Tente novamente.' })
  }
})

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', ffmpeg: ffmpegStatic })
})

app.listen(PORT, () => {
  console.log(`ShopeeClip rodando na porta ${PORT}`)
})
