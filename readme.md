Run async code as sync with workers & shared buffers

```ts
async function main() {
    // allocate sync-async runner
    const runner = await createRunner(1024);

    const text = runner.run(async () => {
        return fetch('https://jsonplaceholder.typicode.com/todos/1').then(x => x.json());
    }, []);

    // we got result in sync way here!
    console.log(text);
}
```

Currenlty works in browser only.  
To run example, do:

```bash
tsc
cd lib
http-server
open http://localhost:8080
# check console
```

## TODO

* nodejs support
* npm package

## PS

While writing prototype, found greate Mutex implementation  
https://blogtitle.github.io/using-javascript-sharedarraybuffers-and-atomics/
