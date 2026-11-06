import assert from "node:assert/strict";
import test from "node:test";
import net from "node:net";
import { once } from "node:events";
import { createRequire } from "node:module";
import { adminRequest, logDirsSchema, quotasSchema, quorumSchema, reassignmentsSchema, ADMIN_APIS } from "./admin-protocol.js";
import { Reader, QueryError, assertReadApi, type ReadApi } from "./protocol.js";
import { auditTopic, parseAuditBaseline } from "./audit.js";
import { KafkaAdminQueries, failureState } from "./admin-queries.js";
import { loadKafkaConfig, validateKafkaConfig } from "./config.js";
import { createKafkaConfigManager } from "./config-manager.js";
import type { KafkaReader } from "./client.js";
import { auditOutput, storageOutput, quotaOutput, reassignmentsOutput, quorumOutput } from "./admin-output.js";
import { KAFKA_PLUGIN_DEFINITION } from "./definition.js";
import { startStandalonePlugin } from "../../core/plugin-runtime.js";
const require = createRequire(import.meta.url);
const createWireRequest = require("kafkajs/src/protocol/request.js") as (args: object) => Promise<{ buffer: Buffer }>;
const config = loadKafkaConfig({ KAFKA_BROKERS: "fixture.invalid:9092" });
const byte = (n:number)=>Buffer.from([n]);
const i16=(n:number)=>{const b=Buffer.alloc(2);b.writeInt16BE(n);return b;};
const i32=(n:number)=>{const b=Buffer.alloc(4);b.writeInt32BE(n);return b;};
const i64=(n:string|number)=>{const b=Buffer.alloc(8);b.writeBigInt64BE(BigInt(n));return b;};
const f64=(n:number)=>{const b=Buffer.alloc(8);b.writeDoubleBE(n);return b;};
const uv=(n:number):Buffer=>{const bs=[];do{const v=n%128;n=Math.floor(n/128);bs.push(v+(n?128:0));}while(n);return Buffer.from(bs);};
const cat=(...bs:Buffer[])=>Buffer.concat(bs);
const str=(s:string|null,flex=false)=>s===null?(flex?uv(0):i16(-1)):cat(flex?uv(Buffer.byteLength(s)+1):i16(Buffer.byteLength(s)),Buffer.from(s));
const array=(bs:Buffer[],flex=false)=>cat(flex?uv(bs.length+1):i32(bs.length),...bs);
const tag=byte(0);
function logResponse(version:number, error=0, dirError=0) {
 const flex=version>=2;const tags=flex?tag:Buffer.alloc(0);
 const part=cat(i32(0),i64('9007199254740993'),i64(0),byte(0),tags);
 const topic=cat(str('orders',flex),array([part],flex),tags);
 const directory=cat(i16(dirError),str('/data/kafka',flex),array([topic],flex),...(version>=4?[i64('18014398509481986'),i64('9007199254740993')]:[]),tags);
 return cat(tags,i32(0),...(version>=3?[i16(error)]:[]),array([directory],flex),tags);
}
function quotaResponse(version:number,error=0){const f=version===1;const t=f?tag:Buffer.alloc(0);return cat(t,i32(0),i16(error),str(null,f),array([cat(array([cat(str('user',f),str(null,f),t)],f),array([cat(str('producer_byte_rate',f),f64(1048576),t)],f),t)],f),t);}
function reassignmentResponse(){return cat(tag,i32(0),i16(0),str(null,true),array([cat(str('orders',true),array([cat(i32(0),array([i32(1),i32(2)],true),array([i32(2)],true),array([i32(1)],true),tag)],true),tag)],true),tag);}
function quorumResponse(version:number,error=0){const member=(id:number,offset:number)=>cat(i32(id),i64(offset),...(version===1?[i64(id===1?-1:1000),i64(1000)]:[]),tag);return cat(tag,i16(error),array([cat(str('__cluster_metadata',true),array([cat(i32(0),i16(0),i32(1),i32(3),i64(95),array([member(1,100),member(2,98)],true),array([],true),tag)],true),tag)],true),tag);}

test("read-only admin protocols encode exact filters, negotiate versions and preserve 64-bit evidence",async()=>{
 for(const version of [1,2,3,4]){
  const request=adminRequest('DescribeLogDirs',{35:{minVersion:version,maxVersion:version}},{topics:[{topic:'orders',partitions:[0]}]});
  const result=logDirsSchema.parse(await request.response.decode(logResponse(version)));
  assert.equal(result.directories[0]?.replicas[0]?.sizeBytes,'9007199254740993');
  assert.equal(result.directories[0]?.totalBytes,version>=4?'18014398509481986':null);
  const wire=await createWireRequest({correlationId:7,clientId:'t',request:request.request});const r=new Reader(wire.buffer.subarray(15));
  if(version>=2){r.tags();assert.equal(r.uvar(),2);assert.equal(r.compact(),'orders');assert.equal(r.uvar(),2);}else{assert.equal(r.i32(),1);assert.equal(r.string(),'orders');assert.equal(r.i32(),1);}
  assert.equal(r.i32(),0);if(version>=2){r.tags();r.tags();}r.done();
 }
 for(const version of [0,1]){
  const request=adminRequest('DescribeClientQuotas',{48:{minVersion:version,maxVersion:version}},{components:[{entityType:'user',matchType:1,match:null}],strict:true});
  const value=quotasSchema.parse(await request.response.decode(quotaResponse(version)));assert.equal(value.entries[0]?.entity[0]?.name,null);assert.equal(value.entries[0]?.values[0]?.value,1048576);
  const wire=await createWireRequest({correlationId:7,clientId:'t',request:request.request});const r=new Reader(wire.buffer.subarray(15));
  if(version){r.tags();assert.equal(r.uvar(),2);assert.equal(r.compact(),'user');}else{assert.equal(r.i32(),1);assert.equal(r.string(),'user');}
  assert.equal(r.bytes(1)[0],1);if(version){assert.equal(r.uvar(),0);r.tags();}else assert.equal(r.nullableString(),null);assert.equal(r.bytes(1)[0],1);if(version)r.tags();r.done();
  const quorum=adminRequest('DescribeQuorum',{55:{minVersion:version,maxVersion:version}},{});const q=quorumSchema.parse(await quorum.response.decode(quorumResponse(version)));assert.equal(q.topics[0]?.partitions[0]?.voters[1]?.lastFetchTimestamp,version?'1000':null);
 }
 const reassign=adminRequest('ListPartitionReassignments',{46:{minVersion:0,maxVersion:0}},{topics:null,timeout:10000});assert.equal(reassignmentsSchema.parse(await reassign.response.decode(reassignmentResponse())).topics[0]?.partitions[0]?.addingReplicas[0],2);
 assert.throws(()=>adminRequest('DescribeQuorum',{},{}),/supported/);
 assert.throws(()=>adminRequest('DescribeQuorum',{55:{minVersion:2,maxVersion:2}},{}),/supported/);
 for(const api of Object.keys(ADMIN_APIS))assert.doesNotThrow(()=>assertReadApi(api));
 for(const api of ['AlterClientQuotas','AlterPartitionReassignments','AlterReplicaLogDirs','AddRaftVoter'])assert.throws(()=>assertReadApi(api),/allowlist/);
});

test("admin decoders reject truncated/oversized arrays, invalid quotas and trailing payload",async()=>{
 const q=adminRequest('DescribeClientQuotas',{48:{minVersion:0,maxVersion:0}},{components:[],strict:false});
 await assert.rejects(q.response.decode(quotaResponse(0).subarray(0,-1)));
 const invalid=cat(i32(0),i16(0),str(null),array([cat(array([cat(str('user'),str(null))]),array([cat(str('producer_byte_rate'),f64(Infinity))]))]));
 await assert.rejects(q.response.decode(invalid),/Non-finite/);
 const storage=adminRequest('DescribeLogDirs',{35:{minVersion:1,maxVersion:1}},{topics:null});
 await assert.rejects(storage.response.decode(cat(i32(0),i32(2147483647))),/Malformed/);
 await assert.rejects(storage.response.decode(cat(logResponse(1),byte(0))),/trailing/);
});

const topic={topic:'orders',isInternal:false,topicErrorCode:0,partitionMetadata:[{partitionId:0,partitionErrorCode:0,leader:1,replicas:[1],isr:[],offlineReplicas:[]}]};
const evidence=(name:string,value:string,sourceCode=5)=>({name,value,sourceCode,isSensitive:false});
test("audit separates unconditional risk, baseline and observations; internal policies are exempt",()=>{
 const configs=[evidence('min.insync.replicas','2'),evidence('retention.ms','-1'),evidence('retention.bytes','-1'),evidence('cleanup.policy','delete',1),evidence('max.message.bytes','1000')];
 const out=auditTopic(topic,configs,{});
 assert.ok(out.some(f=>f.rule==='min_isr_exceeds_replicas'&&f.category==='configuration'));
 assert.ok(out.some(f=>f.rule==='current_isr_below_min'&&f.category==='runtime'));
 assert.ok(out.some(f=>f.rule==='single_replica'&&f.severity==='info'));
 assert.equal(out.filter(f=>f.category==='baseline').length,0);
 const baseline={minReplicationFactor:3,maxRetentionMs:1000,maxMessageBytes:500,allowInfiniteRetention:false};
 assert.ok(auditTopic(topic,configs,baseline).filter(f=>f.category==='baseline').length>=3);
 assert.equal(auditTopic({...topic,isInternal:true},configs,baseline).filter(f=>f.category==='baseline').length,0);
 assert.ok(auditTopic(topic,undefined,{}).some(f=>f.result==='insufficient_evidence'));
});

test("server-owned policies validate, persist, reject per-field mistakes and retain previous state on failure",async()=>{
 for(const raw of ['[]','{"unknown":2}','{"minReplicationFactor":0}','{"maxMessageBytes":1.5}'])assert.throws(()=>parseAuditBaseline(raw));
 assert.throws(()=>validateKafkaConfig({...config,storageImbalanceRatio:1}));
 assert.throws(()=>validateKafkaConfig({...config,storageImbalanceRatio:NaN}));
 let env:Record<string,string>={};const manager=createKafkaConfigManager({environment:()=>env,update:async values=>{env={...env,...values};}});
 await manager.update({values:{KAFKA_AUDIT_BASELINE:'{"minReplicationFactor":3}',KAFKA_STORAGE_IMBALANCE_RATIO:1.5}});
 assert.equal(loadKafkaConfig(env).auditBaseline.minReplicationFactor,3);assert.equal(loadKafkaConfig(env).storageImbalanceRatio,1.5);
 const rev=manager.getSnapshot().revision;await assert.rejects(manager.update({values:{KAFKA_AUDIT_BASELINE:'{"unknown":2}'}}));assert.equal(manager.getSnapshot().revision,rev);
});

function fake(overrides:Partial<Record<ReadApi,(args:Record<string,unknown>,node:number)=>unknown>>={}){
 const calls:{api:ReadApi;args:Record<string,unknown>;node:number}[]=[];
 const brokers=[{nodeId:1,host:'one.invalid',port:9092},{nodeId:2,host:'two.invalid',port:9092}];
 const metadata={brokers,clusterId:'fixture',controllerId:1,topicMetadata:[{...topic,partitionMetadata:[{...topic.partitionMetadata[0]!,replicas:[1,2],isr:[1,2]}]}]};
 const reader:KafkaReader={startedAt:new Date().toISOString(),bootstrap:async()=>brokers[0]!,close(){},versions:async()=>({}),read:async(b,api,args={})=>{
  const a=args as Record<string,unknown>;calls.push({api,args:a,node:b.nodeId});if(overrides[api])return overrides[api]!(a,b.nodeId);
  if(api==='Metadata')return metadata;
  if(api==='DescribeConfigs'){const r=(a.resources as {name:string}[])[0]!;return{resources:[{resourceName:r.name,errorCode:0,configEntries:configNamesFixture.map(([configName,configValue])=>({configName,configValue,configSource:5,isSensitive:false,readOnly:false}))}]};}
  if(api==='DescribeLogDirs')return{errorCode:0,directories:[{errorCode:0,path:'/data',totalBytes:null,usableBytes:null,replicas:[{topic:'orders',partition:0,sizeBytes:b.nodeId===1?'900':'100',offsetLag:'0',isFuture:false}]}]};
  if(api==='DescribeClientQuotas')return{errorCode:0,entries:[]};
  if(api==='ListPartitionReassignments')return{errorCode:0,topics:[]};
  if(api==='DescribeQuorum')return{errorCode:0,topics:[{topic:'__cluster_metadata',partitions:[{partition:0,errorCode:0,leaderId:1,leaderEpoch:2,highWatermark:'95',voters:[{replicaId:1,logEndOffset:'100',lastFetchTimestamp:'-1',lastCaughtUpTimestamp:'1000'},{replicaId:2,logEndOffset:'98',lastFetchTimestamp:'1000',lastCaughtUpTimestamp:'1000'}],observers:[]}]}]};
  throw Error('Unexpected request');
 }};return{reader,calls,metadata};
}
const configNamesFixture=[['min.insync.replicas','1'],['retention.ms','604800000'],['retention.bytes','-1'],['cleanup.policy','delete'],['max.message.bytes','1000012']];

test("storage compares complete selected scope only and separates future replicas",async()=>{
 const f=fake();const q=new KafkaAdminQueries({...config,storageImbalanceRatio:1.5},f.reader);
 const out=storageOutput.parse(await q.execute(()=>q.storage({all:true})));
 assert.equal(out.complete,true);assert.equal(out.data?.comparison.status,'above_threshold');assert.equal(out.data?.comparison.maxToMeanRatio,1.8);
 const broken=fake({DescribeLogDirs:(_a,id)=>{if(id===2)throw new QueryError('CLUSTER_AUTHORIZATION_FAILED','denied');return{errorCode:0,directories:[{errorCode:0,path:'/data',totalBytes:'10000',usableBytes:'5000',replicas:[{topic:'orders',partition:0,sizeBytes:'900',offsetLag:'0',isFuture:false},{topic:'orders',partition:0,sizeBytes:'100',offsetLag:'1',isFuture:true}]}]};}});
 const partial=new KafkaAdminQueries({...config,storageImbalanceRatio:1.5},broken.reader);const p=storageOutput.parse(await partial.execute(()=>partial.storage({all:true})));
 assert.equal(p.status,'partial');assert.equal(p.data?.comparison.status,'insufficient_data');assert.equal(p.data?.comparison.maxToMeanRatio,null);assert.equal(p.data?.distribution[0]?.currentBytes,'900');assert.equal(p.data?.distribution[0]?.futureBytes,'100');
});

test("scope budgets reject before storage/config fan-out and unknown metadata is not healthy data",async()=>{
 const f=fake();const q=new KafkaAdminQueries({...config,maxPartitions:1},f.reader);
 const out=await q.execute(()=>q.storage({all:true}));assert.equal(out.status,'failed');assert.ok(out.errors.some(e=>e.code==='SCOPE_TOO_LARGE'));assert.equal(f.calls.filter(c=>c.api==='DescribeLogDirs').length,0);
 const missing=fake({DescribeLogDirs:()=>({errorCode:0,directories:[{path:'/data',errorCode:0,totalBytes:null,usableBytes:null,replicas:[]}]})});const m=new KafkaAdminQueries(config,missing.reader);const p=storageOutput.parse(await m.execute(()=>m.storage({all:true})));assert.equal(p.complete,false);assert.ok(p.errors.some(e=>e.code==='MISSING_REPLICA'));
});

test("admin result states distinguish support, permission and failures without inferring ZooKeeper",async()=>{
 for(const [code,status]of [['UNSUPPORTED_VERSION','unsupported'],['CLUSTER_AUTHORIZATION_FAILED','forbidden'],['DEADLINE_EXCEEDED','failed'],['NOT_APPLICABLE','not_applicable']]as const){
  assert.equal(failureState(code),status);const f=fake({DescribeQuorum:()=>{throw new QueryError(code,'safe message');}});const q=new KafkaAdminQueries(config,f.reader);const out=quorumOutput.parse(await q.execute(()=>q.quorum()));assert.equal(out.status,status);assert.equal(out.complete,false);assert.equal(out.data,null);
 }
 const f=fake();const q=new KafkaAdminQueries(config,f.reader);const out=quorumOutput.parse(await q.execute(()=>q.quorum()));assert.equal(out.data?.voters[0]?.lastFetchTimestamp,null);assert.equal(out.data?.voters[1]?.lagBehindLeader,'2');
});

test("quota matching expands default candidates without claiming effective limits; reassignments retain empty success",async()=>{
 const f=fake();const q=new KafkaAdminQueries(config,f.reader);const out=quotaOutput.parse(await q.execute(()=>q.quotas({all:false,components:[{entityType:'user',match:'exact',name:'reader'}],strict:false,includeDefaults:true})));
 assert.equal(out.complete,true);assert.equal(out.data?.effectiveQuotaResolved,false);assert.ok(f.calls.filter(c=>c.api==='DescribeClientQuotas').length>1);
 assert.ok(f.calls.some(c=>c.api==='DescribeClientQuotas'&&JSON.stringify(c.args).includes('"matchType":1')));
 const r=new KafkaAdminQueries(config,fake().reader);const result=reassignmentsOutput.parse(await r.execute(()=>r.reassignments({all:true})));assert.equal(result.complete,true);assert.deepEqual(result.data?.partitions,[]);
});

test("audit preserves topic evidence on config failure and reports broker differences without automatic violations",async()=>{
 const f=fake({DescribeConfigs:(a,id)=>{const resource=(a.resources as {type:number;name:string}[])[0]!;if(resource.type===2)throw new QueryError('TOPIC_AUTHORIZATION_FAILED','denied');return{resources:[{resourceName:resource.name,errorCode:0,configEntries:[{configName:'message.max.bytes',configValue:String(id*1000),configSource:4,isSensitive:false,readOnly:false}]}]};}});
 const q=new KafkaAdminQueries(config,f.reader);const out=auditOutput.parse(await q.execute(()=>q.audit({all:true,includeInternal:false,includeBrokerConfigs:true})));
 assert.equal(out.status,'partial');assert.equal(out.data?.topics.length,1);assert.ok(out.data?.findings.some(f=>f.rule==='broker_config_difference'&&f.severity==='info'));assert.ok(out.data?.hasInsufficientEvidence);
});

interface Wire { api:number; version:number; body:Buffer }
async function backend(context:{after:(fn:()=>unknown)=>void}, handler:(r:Wire,port:number)=>Buffer|undefined){
 const sockets=new Set<net.Socket>();const requests:Wire[]=[];
 const server=net.createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});let pending=Buffer.alloc(0);
  socket.on('data',(chunk:Buffer)=>{pending=cat(pending,chunk);while(pending.length>=4&&pending.length>=pending.readInt32BE(0)+4){const n=pending.readInt32BE(0);const frame=pending.subarray(4,n+4);pending=pending.subarray(n+4);const r={api:frame.readInt16BE(0),version:frame.readInt16BE(2),body:frame.subarray(10+frame.readInt16BE(8))};requests.push(r);const value=handler(r,(server.address() as net.AddressInfo).port);if(value){const payload=cat(frame.subarray(4,8),value);socket.write(cat(i32(payload.length),payload));}}});
 });server.listen(0,'127.0.0.1');await once(server,'listening');context.after(async()=>{for(const s of sockets)s.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));});return{port:(server.address() as net.AddressInfo).port,requests};
}
function handler(r:Wire,port:number):Buffer{
 if(r.api===18)return cat(i16(0),array([[3,6],[18,2],[32,2],[35,4],[48,1],[46,0],[55,1]].map(([api,max])=>cat(i16(api!),i16(0),i16(max!)))),i32(0));
 if(r.api===3){const topics=r.body.readInt32BE(0)===0?[]:[cat(i16(0),str('orders'),byte(0),array([cat(i16(0),i32(0),i32(1),array([i32(1)]),array([i32(1)]),array([]))]))];return cat(i32(0),array([cat(i32(1),str('127.0.0.1'),i32(port),str(null))]),str('admin-fixture'),i32(1),array(topics));}
 if(r.api===32){const d=new Reader(r.body);assert.equal(d.i32(),1);const type=d.bytes(1)[0]!;const name=d.string();return cat(i32(0),array([cat(i16(0),str(null),byte(type),str(name),array(configNamesFixture.map(([name,value])=>cat(str(name!),str(value!),byte(0),byte(5),byte(0),array([])))))]));}
 if(r.api===35){assert.equal(r.version,4);const d=new Reader(r.body);d.tags();assert.equal(d.uvar(),0);d.tags();d.done();return logResponse(4);}
 if(r.api===48)return quotaResponse(1);
 if(r.api===46){const d=new Reader(r.body);d.tags();assert.ok(d.i32()<=30000);assert.equal(d.uvar(),0);d.tags();d.done();return reassignmentResponse();}
 if(r.api===55){const d=new Reader(r.body);d.tags();assert.equal(d.uvar(),2);assert.equal(d.compact(),'__cluster_metadata');assert.equal(d.uvar(),2);assert.equal(d.i32(),0);d.tags();d.tags();d.tags();d.done();return quorumResponse(1);}
 throw Error(`Unexpected request ${r.api}`);
}

test("five new tools run through real HTTP and Kafka sockets with strict inputs and structured results",async context=>{
 let denyStorage=false;let omitQuorum=false;
 const b=await backend(context,(r,p)=>{
  if(omitQuorum&&r.api===18)return cat(i16(0),array([[3,6],[18,2],[32,2]].map(([a,v])=>cat(i16(a!),i16(0),i16(v!)))),i32(0));
  return r.api===35&&denyStorage?logResponse(4,31):handler(r,p);
 });
 const runtime=await startStandalonePlugin(KAFKA_PLUGIN_DEFINITION,{port:0,store:{environment:()=>({KAFKA_BROKERS:`127.0.0.1:${b.port}`,MCP_ENABLED_KAFKA:'true'}),update:async()=>{}},logger:{info(){},error(){}}});
 context.after(async()=>{runtime.server.closeAllConnections();await new Promise<void>(resolve=>runtime.server.close(()=>resolve()));});
 async function rpc(method:string,params:object){const r=await fetch(new URL('/kafka/mcp',runtime.url),{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});const text=await r.text();return JSON.parse(text.startsWith('{')?text:text.split('\n').find(l=>l.startsWith('data: '))!.slice(6));}
 const list=await rpc('tools/list',{});assert.equal(list.result.tools.length,11);
 const calls=[['kafka_audit_config',{topics:['orders'],includeBrokerConfigs:true}],['kafka_inspect_storage',{all:true}],['kafka_describe_quotas',{components:[{entityType:'user',match:'exact',name:'reader'}]}],['kafka_list_reassignments',{all:true}],['kafka_describe_quorum',{}]]as const;
 for(const[name,args]of calls){const response=await rpc('tools/call',{name,arguments:args});assert.equal(response.result.isError,false,JSON.stringify(response));assert.equal(response.result.structuredContent.status,'available');assert.equal(response.result.structuredContent.clusterId,'admin-fixture');}
 for(const[name,args]of [['kafka_audit_config',{}],['kafka_audit_config',{all:true,baseline:{minReplicationFactor:1}}],['kafka_inspect_storage',{all:true,brokerIds:[1]}],['kafka_describe_quotas',{components:[{entityType:'user',match:'default',name:'x'}]}],['kafka_describe_quotas',{all:true,strict:true}],['kafka_list_reassignments',{topics:['orders','orders']}]]as const){const n=b.requests.length;const response=await rpc('tools/call',{name,arguments:args});assert.equal(response.result.isError,true);assert.equal(b.requests.length,n);}
 denyStorage=true;const denied=await rpc('tools/call',{name:'kafka_inspect_storage',arguments:{all:true}});assert.equal(denied.result.structuredContent.status,'forbidden');assert.equal(denied.result.isError,true);
 omitQuorum=true;const unsupported=await rpc('tools/call',{name:'kafka_describe_quorum',arguments:{}});assert.equal(unsupported.result.structuredContent.status,'unsupported');assert.equal(unsupported.result.isError,false);assert.equal(unsupported.result.structuredContent.data,null);
 assert.ok(b.requests.every(r=>[18,3,32,35,48,46,55].includes(r.api)));
});

test("audit preserves metadata evidence when DescribeConfigs exhausts the shared deadline",async context=>{
 const b=await backend(context,(r,p)=>r.api===32?undefined:handler(r,p));
 const {createKafkaReader}=await import('./client.js');const c=loadKafkaConfig({KAFKA_BROKERS:`127.0.0.1:${b.port}`,KAFKA_TIMEOUT_MS:'100'});const r=createKafkaReader(c);
 try{const q=new KafkaAdminQueries(c,r);const out=auditOutput.parse(await q.execute(()=>q.audit({topics:['orders'],all:false,includeInternal:false,includeBrokerConfigs:false})));assert.equal(out.status,'partial');assert.equal(out.data?.topics[0]?.topic,'orders');assert.ok(out.errors.some(e=>e.code==='DEADLINE_EXCEEDED'));}finally{r.close();}
});

test("storage never judges a distribution with partition metadata errors or duplicate current replicas",async()=>{
 const f=fake();const original=f.reader.read;
 f.reader.read=async(b,api,args)=>api==='Metadata'?{...f.metadata,topicMetadata:[{...f.metadata.topicMetadata[0]!,partitionMetadata:[{...f.metadata.topicMetadata[0]!.partitionMetadata[0]!,partitionErrorCode:5}]}]}:original(b,api,args);
 const q=new KafkaAdminQueries({...config,storageImbalanceRatio:1.5},f.reader);const out=storageOutput.parse(await q.execute(()=>q.storage({all:true})));assert.equal(out.complete,false);assert.equal(out.data?.comparison.status,'insufficient_data');
 const duplicate=fake({DescribeLogDirs:()=>({errorCode:0,directories:['/one','/two'].map(path=>({path,errorCode:0,totalBytes:null,usableBytes:null,replicas:[{topic:'orders',partition:0,sizeBytes:'100',offsetLag:'0',isFuture:false}]}))})});
 const d=new KafkaAdminQueries({...config,storageImbalanceRatio:1.5},duplicate.reader);const result=storageOutput.parse(await d.execute(()=>d.storage({all:true})));assert.ok(result.errors.some(e=>e.code==='DUPLICATE_REPLICA'));assert.equal(result.data?.comparison.status,'insufficient_data');
});

test("review: explicitly excluded internal topics cannot appear as a complete successful audit",async()=>{
 const f=fake();f.metadata.topicMetadata[0]!.isInternal=true;f.metadata.topicMetadata[0]!.topic='__internal';
 const q=new KafkaAdminQueries(config,f.reader);const out=auditOutput.parse(await q.execute(()=>q.audit({all:false,topics:['__internal'],includeInternal:false,includeBrokerConfigs:false})));
 assert.equal(out.complete,false);assert.ok(out.errors.some(e=>e.code==='INTERNAL_TOPIC_EXCLUDED'));
 const all=new KafkaAdminQueries(config,f.reader);const filtered=await all.execute(()=>all.audit({all:true,includeInternal:false,includeBrokerConfigs:false}));assert.equal(filtered.complete,true);
});

test("review: inventory-dependent queries preserve cluster metadata permission classification",async()=>{
 for(const method of ['storage','reassignments']as const){
  const f=fake({Metadata:()=>{throw new QueryError('CLUSTER_AUTHORIZATION_FAILED','denied');}});const q=new KafkaAdminQueries(config,f.reader);
  const out=await q.execute<unknown>(()=>q[method]({all:true}));assert.equal(out.status,'forbidden');assert.equal(out.data,null);
 }
});

test("review: storage threshold comparison does not round away a small but real exceedance",async()=>{
 const f=fake({DescribeLogDirs:(_a,id)=>({errorCode:0,directories:[{path:'/data',errorCode:0,totalBytes:null,usableBytes:null,replicas:[{topic:'orders',partition:0,sizeBytes:id===1?'3000001':'999999',offsetLag:'0',isFuture:false}]}]})});
 const q=new KafkaAdminQueries({...config,storageImbalanceRatio:1.5},f.reader);const out=storageOutput.parse(await q.execute(()=>q.storage({all:true})));
 assert.equal(out.data?.comparison.status,'above_threshold');
});

test("review: storage stops scheduling brokers as soon as returned replica budget is exhausted",async()=>{
 const f=fake({DescribeLogDirs:()=>({errorCode:0,directories:[{path:'/data',errorCode:0,totalBytes:null,usableBytes:null,replicas:[0,1].map(partition=>({topic:'orphan',partition,sizeBytes:'100',offsetLag:'0',isFuture:false}))}]})});
 f.metadata.topicMetadata=[];
 f.metadata.brokers.push({nodeId:3,host:'three.invalid',port:9092});
 const q=new KafkaAdminQueries({...config,maxPartitions:1,concurrency:1},f.reader);const out=await q.execute(()=>q.storage({all:true}));
 assert.equal(out.status,'failed');assert.ok(out.errors.some(e=>e.code==='SCOPE_TOO_LARGE'));assert.equal(f.calls.filter(c=>c.api==='DescribeLogDirs').length,1);
});

test("review: selected-broker storage budget ignores partitions exclusively hosted elsewhere",async()=>{
 const f=fake();const t=f.metadata.topicMetadata[0]!;t.partitionMetadata[0]!.replicas=[1];
 t.partitionMetadata.push({...t.partitionMetadata[0]!,partitionId:1,replicas:[2],leader:2,isr:[2]});
 const q=new KafkaAdminQueries({...config,maxPartitions:1},f.reader);const out=storageOutput.parse(await q.execute(()=>q.storage({all:false,brokerIds:[1]})));
 assert.equal(out.complete,true);assert.equal(out.data?.distribution.length,1);assert.equal(f.calls.filter(c=>c.api==='DescribeLogDirs').length,1);
});

test("review: binary array counts are bounded by unread bytes, not original frame length",()=>{
 const r=new Reader(Buffer.alloc(128));r.bytes(127);assert.throws(()=>r.count(100),/Malformed/);
});
