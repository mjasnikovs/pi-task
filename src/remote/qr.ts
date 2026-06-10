import qrcode from 'qrcode'

export async function qrLines(url: string): Promise<string[]> {
    const raw = await qrcode.toString(url, {type: 'terminal', small: true})
    return raw.split('\n').filter(l => l.length > 0)
}
