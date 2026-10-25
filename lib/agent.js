import { reason } from './groq.js';
import {
  createSession, getSession, appendMessage, updateSessionContext,
  setPendingTriage, getPendingTriage, clearPendingTriage,
} from './session-store.js';
import { logger } from './logger.js';
import { Errors } from './errors.js';

function buildFallbackAdvisory(reasonError) {
  logger.error({ err: { message: reasonError.message, stack: reasonError.stack } }, 'agent.fallback_advisory');
  return {
    record_kind: 'refusal',
    language: 'en',
    channel: 'voice',
    context: { crop: null, growth_stage: null, chief_complaint_en: 'Could not process request.', chief_complaint_sw: 'Ombi halikuweza kuchakatwa.' },
    triage: { observed_signs: [], missing_discriminators: [], questions: [] },
    diagnosis: null,
    advice: null,
    escalation: {
      trigger_en: 'Unable to provide advice right now. Please try again or contact your extension officer.',
      trigger_sw: 'Imeshindwa kutoa ushauri sasa. Tafadhali jaribu tena au wasiliana na afisa wako wa ugani.',
      referral: 'Contact your local agricultural extension officer.',
      referral_sw: 'Wasiliana na afisa wa ugani wa eneo lako.',
      urgency: 'medium'
    },
    provenance: { fact_ids: [], source_names: [] },
    policy_trace: [{ step: 'close', action: 'emit_fallback' }],
    refusal: {
      reason_en: 'The system could not produce a reliable advisory for this request. Please rephrase or contact a human extension officer.',
      reason_sw: 'Mfumo haukuweza kutoa ushauri wa kuaminika kwa ombi hili. Tafadhali rudia au wasiliana na afisa wa ugani.',
      category: 'insufficient_info',
      redirect_to: 'Try again, or contact your extension officer.'
    }
  };
}

export async function handleMessage(sessionId, userInput) {
  if (!userInput || typeof userInput !== 'string') throw Errors.validation('input must be a non-empty string');

  let session = sessionId ? getSession(sessionId) : null;
  let newSessionToken = null;
  if (!session) {
    session = createSession();
    sessionId = session.id;
    newSessionToken = session.sessionToken;
  }

  const pending = getPendingTriage(sessionId);
  const isTriageAnswer = pending && pending.questions.length > 0;
  let augmentedInput = userInput;
  let farmerAnswer = null;

  if (isTriageAnswer) {
    const [firstQuestion, ...rest] = pending.questions;
    farmerAnswer = userInput;
    appendMessage(sessionId, 'user', 'triage_answer', {
      field: firstQuestion.field,
      question: firstQuestion.ask_en,
      questionSw: firstQuestion.ask_sw,
      answer: userInput,
    });

    const history = getSession(sessionId).messages.filter(m => m.kind === 'triage_answer');
    const answerLines = history.map(m => `- Q: ${m.content.question}\n  A: ${m.content.answer}`).join('\n');
    const originalComplaint = getSession(sessionId).messages
      .find(m => m.kind === 'user_text')?.content?.text || userInput;

    augmentedInput = `${originalComplaint}\n\nClarifications from farmer:\n${answerLines}\n\nThe farmer has now answered the triage questions.`;

    if (rest.length > 0) {
      setPendingTriage(sessionId, rest, pending.advisoryMessageId);
    } else {
      clearPendingTriage(sessionId);
    }
  } else {
    appendMessage(sessionId, 'user', 'user_text', { text: userInput });
  }

  let result;
  let degraded = false;
  try {
    result = await reason(augmentedInput, { isTriageAnswer, farmerAnswer });
  } catch (err) {
    logger.error({ err: { message: err.message, stack: err.stack } }, 'agent.reason_failed');
    degraded = true;
    result = {
      advisory: buildFallbackAdvisory(err),
      retried: false,
      fewShotsUsed: 0,
      detectedLang: null,
      detectedCrop: null,
      cached: false,
      translation: null,
      diagnosisEnforced: false
    };
  }

  const advisory = result.advisory;
  const advisoryMsg = appendMessage(sessionId, 'assistant', 'advisory', advisory);

  const triageQuestions = advisory.triage?.questions || [];
  const confidence = advisory.diagnosis?.primary?.confidence;
  const shouldAskMore = triageQuestions.length > 0
    && advisory.record_kind === 'diagnostic_episode'
    && confidence !== 'confirmed';

  if (shouldAskMore && !pending) {
    setPendingTriage(sessionId, triageQuestions, advisoryMsg.id);
  }

  const current = getSession(sessionId);
  updateSessionContext(sessionId, {
    ...current.context,
    crop: advisory.context?.crop || current.context.crop || null,
    growth_stage: advisory.context?.growth_stage || current.context.growth_stage || null,
    lastConfidence: confidence,
  });

  logger.info('agent.turn', {
    sessionId,
    recordKind: advisory.record_kind,
    confidence,
    questionsAsked: shouldAskMore ? triageQuestions.length : 0,
    cached: result.cached,
    diagnosisEnforced: result.diagnosisEnforced,
    wasAnswering: Boolean(pending),
    degraded
  });

  return {
    sessionId,
    ...(newSessionToken ? { sessionToken: newSessionToken } : {}),
    advisory,
    advisoryMessageId: advisoryMsg.id,
    pendingQuestions: shouldAskMore && !pending ? triageQuestions : (getPendingTriage(sessionId)?.questions || []),
    cached: result.cached || false,
    translation: result.translation || null,
    diagnosisEnforced: result.diagnosisEnforced || false,
    degraded,
    metadata: {
      retried: result.retried,
      fewShotsUsed: result.fewShotsUsed,
      detectedLang: result.detectedLang,
      detectedCrop: result.detectedCrop,
      cached: result.cached || false,
    },
  };
}

export function getSessionView(sessionId) {
  const session = getSession(sessionId);
  if (!session) throw Errors.notFound('Session not found');
  return session;
}