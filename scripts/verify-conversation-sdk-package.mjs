// Publishability check: install the real tarball outside the monorepo, typecheck/build an ordinary consumer, SSR import.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const root=process.cwd();
const output=path.resolve('.visual/workflow/vision/conversation-sdk/package');fs.mkdirSync(output,{recursive:true});
const packed=JSON.parse(execFileSync('npm',['pack','--workspace','@hemi/conversation-flow','--ignore-scripts','--json','--pack-destination',output],{encoding:'utf8'}))[0];
const consumer=fs.mkdtempSync(path.join(os.tmpdir(),'hemi-flow-consumer-'));
const packageFile=path.join(output,packed.filename);
for(const filename of ['main.tsx','native-entry.ts','style.css','index.html','tsconfig.json','vite.config.mjs','build-standalone.mjs'])fs.copyFileSync(path.join(root,'examples/conversation-flow',filename),path.join(consumer,filename));
const manifest=JSON.parse(fs.readFileSync('examples/conversation-flow/package.json','utf8'));
manifest.dependencies['@hemi/conversation-flow']=packageFile;
fs.writeFileSync(path.join(consumer,'package.json'),JSON.stringify(manifest,null,2));
const report={consumer,filename:packageFile,packageBytes:packed.size,unpackedBytes:packed.unpackedSize,files:packed.files.length,checks:[]};
try{
 execFileSync('npm',['install','--ignore-scripts','--no-audit','--no-fund'],{cwd:consumer,stdio:'pipe'});report.checks.push('tarball installed outside repository');
 fs.writeFileSync(path.join(consumer,'core-check.tsx'),"import {createConversation, createDraftPersistence, projectConversationQueue, type ConversationTransport} from '@hemi/conversation-flow/core';import{useConversation}from'@hemi/conversation-flow/react';export {createConversation,createDraftPersistence,projectConversationQueue,useConversation};export type {ConversationTransport};\n");
 execFileSync('npm',['run','build'],{cwd:consumer,stdio:'pipe'});report.checks.push('consumer TypeScript, Vite and standalone build passed');
 execFileSync(process.execPath,['--input-type=module','-e',`import {createConversation} from '@hemi/conversation-flow/core';import{useConversation}from'@hemi/conversation-flow/react';if(!createConversation||!useConversation)throw Error('missing state exports');import React from 'react';import{renderToString}from'react-dom/server';import{ConversationFlow}from'@hemi/conversation-flow';import{createWebHost}from'@hemi/conversation-flow/web-host';import{createNativeHost}from'@hemi/conversation-flow/native-host';import{RunActivity}from'@hemi/conversation-flow/parts';if(typeof window!=='undefined')throw Error('unexpected DOM');const html=renderToString(React.createElement(ConversationFlow,{scope:{environmentId:'server',conversationId:'one',generation:'1'},messages:[{id:'one',author:'assistant',text:'safe'}]}));if(!html.includes('data-hemi-conversation-flow')||!createWebHost||!createNativeHost||!RunActivity)throw Error('bad exports');`],{cwd:consumer,stdio:'pipe'});report.checks.push('all public entries import in Node; SSR without window/document passed');
 fs.copyFileSync(path.join(consumer,'dist/standalone.html'),path.join(output,'consumer.html'));
 console.log(JSON.stringify(report,null,2));
}catch(error){report.error=String(error);if(error.stdout)console.error(error.stdout.toString());if(error.stderr)console.error(error.stderr.toString());throw error;}finally{fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));fs.rmSync(consumer,{recursive:true,force:true});}
