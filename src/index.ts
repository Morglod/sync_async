type _TypedArray =
    Int8Array | Uint8Array |
    Int16Array | Uint16Array |
    Int32Array | Uint32Array |
    Float32Array | Float64Array
;

function atomicsWriteToBuffer(
    target: SharedArrayBuffer,
    dstOffset: number,
    srcBuf: _TypedArray,
    srcLen: number,
    targetNotifValue: number
) {
    // 2 int32 for header
    // [ notif value, size ]
    const HEADER_SIZE_BYTES = 8;
    const dstByteBuf = new Int8Array(target);
    const srcBuf8 = new Int8Array(srcBuf.buffer);

    for (let i = 0; i < srcLen; ++i) {
        Atomics.store(dstByteBuf, HEADER_SIZE_BYTES + i + dstOffset, srcBuf8[i]);
    }

    const notifBuf = new Int32Array(target);
    notifBuf[1] = srcLen;

    Atomics.store(notifBuf, 0, targetNotifValue);
    Atomics.notify(notifBuf, 0);
}

function atomicsReadData(target: SharedArrayBuffer) {
    const notifBuf = new Int32Array(target);
    const dataSize = notifBuf[1];

    // 2 int32 for header
    // [ notif value, size ]
    const HEADER_SIZE_BYTES = 8;
    const buf = target.slice(HEADER_SIZE_BYTES, HEADER_SIZE_BYTES + dataSize);
    return buf;
}

function arrayBufferToString(buffer: ArrayLike<any> | SharedArrayBuffer) {
    // https://stackoverflow.com/a/20604561/5222353
    // faster than solution with Blob

    const bufView = new Int16Array(buffer);
    const length = bufView.length;
    let result = '';
    let addition = Math.pow(2,16)-1;

    result += String.fromCharCode(...bufView.values());

    // for(let i = 0; i < length; i += addition) {
    //     if(i + addition > length){
    //         addition = length - i;
    //     }
    //     result += String.fromCharCode.call(null, bufView.subarray(i,i+addition) as any);
    // }

    return result;
}

function stringToBuf(str: string) {
    const bufView = new Int16Array(str.length);
    for (let i = 0, strLen = str.length; i < strLen; i++) {
        bufView[i] = str.charCodeAt(i);
    }
    return bufView;
}

function atomicsWaitFor(
    typedArray: SharedArrayBuffer | Int32Array,
    indexInt32: number,
    waitFor: number,
    totalTimeout?: number,
    stepTimeout?: number,
) {
    if (typedArray instanceof SharedArrayBuffer) typedArray = new Int32Array(typedArray);

    const start = performance.now();
    const cur = Atomics.load(typedArray, indexInt32);

    while(totalTimeout !== undefined ? (performance.now() - start < totalTimeout) : true) {
        if (Atomics.wait(typedArray, indexInt32, cur, stepTimeout) === 'ok') {
            const cur = Atomics.load(typedArray, indexInt32);
            if (waitFor === cur) {
                return 'ok';
            }
        }
    }

    return 'timed-out';
}

type Runner = {
    sharedBuffer: SharedArrayBuffer,
    run: (
        func: (...args: any[]) => any,
        args: any[]
    ) => any
};

const RUN_NEW_FUNC_NOTIF = 10;
const FUNC_DONE_NOTIF = 20;

const runnerDeps = `
    const atomicsReadData = (${atomicsReadData.toString()});
    const atomicsWriteToBuffer = (${atomicsWriteToBuffer.toString()});
    const arrayBufferToString = (${arrayBufferToString.toString()});
    const stringToBuf = (${stringToBuf.toString()});
    const atomicsWaitFor = (${atomicsWaitFor.toString()});
    const RUN_NEW_FUNC_NOTIF = (${RUN_NEW_FUNC_NOTIF.toString()});
    const FUNC_DONE_NOTIF = (${FUNC_DONE_NOTIF.toString()});
`;

async function createRunner(
    sharedBufferSize: number,
): Promise<Runner> {
    // declaration for typing inside code generation
    let postMessage!: (payload: any) => void;

    const workerMain = async (sharedBuffer: SharedArrayBuffer) => {
        console.log('before1');
        while (atomicsWaitFor(sharedBuffer, 0, RUN_NEW_FUNC_NOTIF) === 'ok') {
            console.log('before2', new Int8Array(sharedBuffer))
            // const strBufSlice = new Int16Array(sharedBuffer).subarray(8)
            const strBufSlice = atomicsReadData(sharedBuffer);
            const funcCode = arrayBufferToString(strBufSlice);
            console.log([funcCode])
            const func = eval(funcCode);

            const result = await func();
            const resultStr = JSON.stringify(result);
            const resultStrBuf = stringToBuf(resultStr);

            atomicsWriteToBuffer(
                sharedBuffer,
                0,
                resultStrBuf,
                resultStrBuf.byteLength,
                FUNC_DONE_NOTIF
            );
        }
    };

    const workerCode = `(() => {
        ${runnerDeps}
        const workerMain = ${workerMain.toString()};

        let out_sharedArrayBuf;
        self.onmessage = (ev) => {
            console.log('worker main');
            if (typeof ev.data === 'object' && ev.data.type === 'init') {
                out_sharedArrayBuf = ev.data.sharedArrayBuf;
                workerMain(out_sharedArrayBuf);
            }
        };
    })()`;

    console.log(workerCode);

    const sharedBuffer = new SharedArrayBuffer(sharedBufferSize);

    const workerCodeBlob = new Blob([ workerCode ], { type: 'text/javascript' });
    const worker = new Worker(URL.createObjectURL(workerCodeBlob));

    await new Promise<void>((resolve) => {
        worker.postMessage({
            type: 'init',
            sharedArrayBuf: sharedBuffer
        });

        // wait for postMessage
        setTimeout(() => {
            resolve();
        }, 500);
    });

    const runner = (
        func: (...args: any[]) => void,
        args: any[]
    ) => {
        const funcCode = func.toString();

        // assert
        if (funcCode.endsWith(') { [native code] }')) {
            throw new Error('Cannot run native function');
        }

        const jobCode = `(() => {
            const func = (${funcCode});
            const args = (${JSON.stringify(args)});
            return func(args);
        })`;

        const jobCodeBuf = stringToBuf(jobCode);
        atomicsWriteToBuffer(
            sharedBuffer,
            0,
            jobCodeBuf,
            jobCodeBuf.byteLength,
            RUN_NEW_FUNC_NOTIF
        );

        const i32Buf = new Int32Array(sharedBuffer);
        console.log('before', new Int8Array(sharedBuffer));
        if (atomicsWaitFor(i32Buf, 0, FUNC_DONE_NOTIF) !== 'ok') {
            throw new Error('syncAsync timeout');
        }
        console.log('after');

        const totalDataSize = i32Buf[1];
        if (totalDataSize + 8 > sharedBufferSize) throw new Error('syncAsync out of memory');

        const outDataBuf = atomicsReadData(sharedBuffer);
        const dataStr = arrayBufferToString(outDataBuf);
        console.log([dataStr]);
        return JSON.parse(dataStr);
    };

    return {
        sharedBuffer,
        run: runner,
    };
}

async function main() {
    const runner = await createRunner(1024);

    const text = runner.run(async () => {
        return fetch('https://jsonplaceholder.typicode.com/todos/1').then(x => x.json());
    }, []);

    console.log(text);
}

main();