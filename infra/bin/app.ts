#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { WoundCareStack } from '../lib/wound-care-stack';

const app = new cdk.App();
new WoundCareStack(app, 'WoundCare', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT ?? '123456789012',
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Wound-care FHIR read API, lakehouse, and risk-score endpoint.',
});
