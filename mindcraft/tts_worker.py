# tts_worker.py — 常驻 edge-tts 合成进程（省去每次冷启动 ~1s）
# 协议：stdin 每行一个 JSON {id, text, out}；stdout 每行回 {id, ok, error?}
import sys
import json
import asyncio


async def synth(req):
    import edge_tts
    await edge_tts.Communicate(
        req['text'], 'zh-CN-XiaoyiNeural', rate='+20%'
    ).save(req['out'])


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            asyncio.run(synth(req))
            print(json.dumps({'id': req['id'], 'ok': True}), flush=True)
        except Exception as e:
            try:
                rid = req.get('id', -1)
            except Exception:
                rid = -1
            print(json.dumps({'id': rid, 'ok': False, 'error': str(e)}), flush=True)


if __name__ == '__main__':
    main()
