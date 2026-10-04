from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import subprocess, json, sys, tempfile
root = Path(__file__).resolve().parents[2]
out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(tempfile.mkdtemp(prefix='kyoot-contract-probes-'))
out.mkdir(parents=True, exist_ok=True)
header='''import { effect, Kyoot, makeHandler, Async, Clock, Var, type EffectRow, type Requirement, type RowsOf, type Row, type MergeAll } from '__KY_ROOT__/packages/kyoot/src/index.ts';
type Numbers=EffectRow<'s',void,number>;
type Strings=EffectRow<'s',void,string>;
type C=Partial<Numbers>|Partial<Strings>;
type Own=EffectRow<'n',void,number,C>;
const N=effect<void,number,C>()('n');
const NumberSource=effect<void,number>()('s');
const TextSource=effect<void,string>()('s');
const handle=N.handle({onOp:(_,r)=>r.with(NumberSource(undefined))});
const text=TextSource.handle({onOp:(_,r)=>r('incorrect')});
const p=N(undefined);
'''
header = header.replace('__KY_ROOT__', root.as_posix())
cases={
'pick-erasure':"const erased: Kyoot<number, Pick<RowsOf<typeof p>,'n'>>=p; Kyoot.runSync(erased.pipe(handle));",
'mapped-narrow':"type Narrow={ [K in keyof RowsOf<typeof p>]: K extends 's'?Strings['s']:RowsOf<typeof p>[K] }; const q:Kyoot<number,Narrow>=p; const value:number=Kyoot.runSync(q.pipe(handle,text));",
'partial-row-annotation':"const q:Kyoot<number,Partial<RowsOf<typeof p>>>=p;",
'unnormalized-union-annotation':"const q:Kyoot<number,Own & C>=p;",
'required-unnormalized-annotation':"const q:Kyoot<number,Own & Required<C>>=p;",
'direct-handler-explicit':"const q=N.handler<number, Own&Strings>(p,{onOp:(_,r)=>r.with(NumberSource(undefined))}); const value:number=Kyoot.runSync(q.pipe(text));",
'handler-explicit-row':"const q=handle<number,Own&Strings>(p); const value:number=Kyoot.runSync(q.pipe(text));",
'raw-handler-explicit-row':"const q=makeHandler<'n',number,Own&Strings>('n',p,{onOp:(_,r)=>r(1)});",
'interceptor-narrow':"const q:Kyoot<number,Own&Strings>=p.pipe(N.intercept((_,next)=>next(undefined)));",
'generator-narrow':"const q:Kyoot<number,Own&Strings>=Kyoot.gen(function*(){return yield* p;});",
'flatmap-narrow':"const q:Kyoot<number,Own&Strings>=Kyoot.succeed(0).flatMap(()=>p);",
'function-return-narrow':"function q():Kyoot<number,Own&Strings>{return p}",
'generic-normalized-to-original':"function q<T extends Row>(x:Kyoot<number,EffectRow<'n',void,number,T>&MergeAll<Required<T>>>):Kyoot<number,EffectRow<'n',void,number,T>&T>{return x;} q<C>(p);",
'runner-explicit-erasure':"Kyoot.runSync<number,{}>(p.pipe(handle));",
'row-intersection-answer':"const q:Kyoot<number,Own&Numbers&Strings>=p;",
'structural-rest-erasure':"const {_,...withoutWitness}=p;const q:Kyoot<number,{}>=withoutWitness;",
'optional-raw-entry-narrow':"const q:Kyoot<number,Own&{s?:Strings['s']}>=p;",
'outer-union-branch-narrow':"const q:Kyoot<number,(Own&Numbers)|(Own&Strings)>=p;",
'generic-pair':"function q<S extends Row>(first:Kyoot<number,S>,second:Kyoot<number,S>){return first;}q(p,Kyoot.succeed(0).flatMap(()=>TextSource(undefined).map(()=>1)));",
'with-explicit-empty':"N.handle({onOp:(_,r)=>r.with<{}>(NumberSource(undefined))});",
'with-explicit-optional':"N.handle({onOp:(_,r)=>r.with<Partial<C>>(NumberSource(undefined))});",
'with-hidden-disjoint':"const T=effect<void,number>()('t');N.handle({onOp:(_,r)=>r.with(Math.random()>0.5?NumberSource(undefined):T(undefined))});",
'with-nested-optional-loss':"const Inner=effect<void,number,Partial<Numbers>>()('inner');const Outer=effect<void,number,Partial<EffectRow<'inner',void,number,Partial<Numbers>>>>()('outer');Outer.handle({onOp:(_,r)=>r.with(Inner(undefined))});",
'runPromise-clock-intersection':"const Bad=effect<void,string>()('clock');const q:Kyoot<string,EffectRow<'clock',void,string>&{clock:number}>=Bad(undefined);Kyoot.runPromise(q);",
'async-all-clock-bypass':"const Bad=effect<void,string>()('clock');const q=Async.all([Bad(undefined)]);Kyoot.runPromise(q);",
'var-generic-fixed':"const counter=Var.tag<number>()('counter');const Bad=effect<Var.VarOp<number>,string,{},number>()('var/counter');Bad.handler(counter.get(),{onOp:(_,r)=>r('incorrect')});",
'optional-union-declaration-narrow':"const Narrow=effect<void,number,Partial<Strings>>()('n');p.pipe(Narrow.handle({onOp:(_,r)=>r.with(TextSource(undefined).map(t=>t.length))}));"
}
args=[str(root/'node_modules/.bin/tsc'),'--ignoreConfig','--strict','--noUncheckedIndexedAccess','--exactOptionalPropertyTypes','false','--target','es2022','--module','nodenext','--moduleResolution','nodenext','--types','node','--typeRoots',str(root/'node_modules/@types'),'--noEmit','--allowImportingTsExtensions','--skipLibCheck']
def run(item):
 name,body=item
 path=out/(name+'.mts');path.write_text(header+body+'\n')
 p=subprocess.run(args+[str(path)],cwd=root,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
 (out/(name+'.log')).write_text(p.stdout)
 return {'case':name,'compiler_exit':p.returncode,'diagnostic':p.stdout.splitlines()[0] if p.stdout else ''}
with ThreadPoolExecutor(max_workers=4) as pool: results=list(pool.map(run,cases.items()))
(out/'results.json').write_text(json.dumps(results,indent=2)+'\n')
for r in results: print('REJECTED' if r['compiler_exit']==1 else 'ACCEPTED',r['case'],r['diagnostic'])

if not all(r["compiler_exit"] == 1 and ("TS2322" in r["diagnostic"] or "TS2345" in r["diagnostic"]) for r in results):
    raise SystemExit("A contract bypass compiled or failed for an unexpected reason")
print(f"Verified {len(results)} rejected public bypasses; evidence in {out}")
