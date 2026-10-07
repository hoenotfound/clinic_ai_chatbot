import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import Spinner from "../components/Spinner";
import { ToastContainer, useToasts } from "../components/Toast";
import LeadDistribution from "./LeadDistribution";

const DEFAULT_FOLLOW_UP = {
  enabled: false,
  delayMinutes: 120,
  timingMode: "after_reply",
  beforeWindowExpiryMinutes: 120,
  triggerMode: "all",
  quietHours: {
    enabled: true,
    start: "00:00",
    end: "07:00",
  },
  messageMode: "fixed",
  aiInstruction: "",
  message: "Hi! Just checking in to see if you still need any help. Feel free to reply whenever you're ready 😊",
  translations: {
    en: "Hi! Just checking in to see if you still need any help. Feel free to reply whenever you're ready 😊",
    ms: "Hai! Saya cuma ingin bertanya sama ada anda masih memerlukan bantuan. Balas sahaja apabila anda sudah bersedia 😊",
    zh: "嗨！想跟进一下，看看您是否还需要任何帮助。方便时回复我们就可以了 😊",
  },
  imageUrl: "",
  videoKey: "",
  videoFilename: "",
  serviceOverrides: [],
  additionalSteps: [],
};

const DEFAULT_LEAD_SCORING = {
  enabled: false,
  inactivityMinutes: 10,
  maxConversationMinutes: 60,
  maxMessages: 40,
};

const DEFAULT_COMMENT_AUTOMATION = {
  enabled: false,
  facebookEnabled: true,
  instagramEnabled: true,
  publicReplyEnabled: true,
  privateReplyEnabled: true,
  publicReplyStyle: "ai",
  fixedPublicReply: "Thanks for your comment! I’ll send you a private message 😊",
  skipEmojiOnly: true,
  skipNestedReplies: true,
};

const FOLLOW_UP_LANGUAGES = [
  { key: "en", label: "English" },
  { key: "ms", label: "Bahasa Malaysia" },
  { key: "zh", label: "中文" },
];

const MAX_FOLLOW_UP_IMAGE_BYTES = 5 * 1024 * 1024;
const FOLLOW_UP_IMAGE_TYPES = new Set(["image/jpeg", "image/png"]);
const MAX_FOLLOW_UP_VIDEO_BYTES = 16 * 1024 * 1024;

function hasCompleteTranslations(value) {
  return !!value && FOLLOW_UP_LANGUAGES.every(({ key }) => value[key]?.trim());
}

function normalizeTranslations(value, fallbackMessage, useDefaultTranslations = false) {
  if (hasCompleteTranslations(value)) {
    return Object.fromEntries(
      FOLLOW_UP_LANGUAGES.map(({ key }) => [key, value[key]])
    );
  }
  return {
    en: fallbackMessage,
    ms: useDefaultTranslations ? DEFAULT_FOLLOW_UP.translations.ms : "",
    zh: useDefaultTranslations ? DEFAULT_FOLLOW_UP.translations.zh : "",
  };
}

function normalizeServiceOverrides(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const serviceName = String(item?.serviceName || "").trim();
      const message = String(item?.message || "").trim();
      if (!serviceName || !message) return null;
      return {
        serviceName,
        message,
        translations: normalizeTranslations(item?.translations, message),
        imageUrl: String(item?.imageUrl || ""),
        videoKey: String(item?.videoKey || ""),
        videoFilename: String(item?.videoFilename || ""),
      };
    })
    .filter(Boolean);
}

function normalizeSequenceStep(value = {}) {
  const message = String(value.message || "").trim();
  const timingMode =
    value.timingMode === "before_window_expiry"
      ? "before_window_expiry"
      : "after_reply";
  const beforeWindowExpiryMinutes =
    Number(value.beforeWindowExpiryMinutes) || 120;
  return {
    delayMinutes:
      timingMode === "before_window_expiry"
        ? 24 * 60 - beforeWindowExpiryMinutes
        : Number(value.delayMinutes) || 120,
    timingMode,
    beforeWindowExpiryMinutes,
    messageMode: value.messageMode === "ai" ? "ai" : "fixed",
    aiInstruction: String(value.aiInstruction || ""),
    message,
    translations: normalizeTranslations(value.translations, message),
    imageUrl: value.imageUrl || "",
    videoKey: value.videoKey || "",
    videoFilename: value.videoFilename || "",
    serviceOverrides: normalizeServiceOverrides(value.serviceOverrides),
  };
}

function normalizeFollowUpSettings(value = {}) {
  const settings = { ...DEFAULT_FOLLOW_UP, ...value };
  const quietHours = {
    ...DEFAULT_FOLLOW_UP.quietHours,
    ...(value?.quietHours && typeof value.quietHours === "object"
      ? value.quietHours
      : {}),
  };
  const usesDefaultMessage = settings.message === DEFAULT_FOLLOW_UP.message;
  const firstTimingMode =
    settings.timingMode === "before_window_expiry"
      ? "before_window_expiry"
      : "after_reply";
  const firstBeforeWindowExpiryMinutes =
    Number(settings.beforeWindowExpiryMinutes) ||
    DEFAULT_FOLLOW_UP.beforeWindowExpiryMinutes;
  const firstStep = {
    delayMinutes:
      firstTimingMode === "before_window_expiry"
        ? 24 * 60 - firstBeforeWindowExpiryMinutes
        : Number(settings.delayMinutes) || DEFAULT_FOLLOW_UP.delayMinutes,
    timingMode: firstTimingMode,
    beforeWindowExpiryMinutes: firstBeforeWindowExpiryMinutes,
    messageMode: settings.messageMode === "ai" ? "ai" : "fixed",
    aiInstruction: String(settings.aiInstruction || ""),
    message: settings.message || DEFAULT_FOLLOW_UP.message,
    translations: normalizeTranslations(
      value.translations,
      settings.message || DEFAULT_FOLLOW_UP.message,
      usesDefaultMessage
    ),
    imageUrl: settings.imageUrl || "",
    videoKey: settings.videoKey || "",
    videoFilename: settings.videoFilename || "",
    serviceOverrides: normalizeServiceOverrides(value.serviceOverrides),
  };

  return {
    ...settings,
    quietHours: {
      enabled: quietHours.enabled !== false,
      start: String(quietHours.start || DEFAULT_FOLLOW_UP.quietHours.start),
      end: String(quietHours.end || DEFAULT_FOLLOW_UP.quietHours.end),
    },
    ...firstStep,
    additionalSteps: Array.isArray(value.additionalSteps)
      ? value.additionalSteps.slice(0, 2).map(normalizeSequenceStep)
      : [],
  };
}

function followUpFormFromSettings(value = {}) {
  const settings = normalizeFollowUpSettings(value);
  return {
    enabled: !!settings.enabled,
    triggerMode: settings.triggerMode === "staff" ? "staff" : "all",
    quietHours: settings.quietHours,
    delayMinutes: settings.delayMinutes,
    timingMode: settings.timingMode,
    beforeWindowExpiryMinutes: settings.beforeWindowExpiryMinutes,
    messageMode: settings.messageMode,
    aiInstruction: settings.aiInstruction,
    message: settings.message,
    translations: settings.translations,
    imageUrl: settings.imageUrl,
    videoKey: settings.videoKey,
    videoFilename: settings.videoFilename,
    serviceOverrides: settings.serviceOverrides,
    additionalSteps: settings.additionalSteps,
  };
}

function comparableFollowUp(value = {}) {
  const settings = followUpFormFromSettings(value);
  return {
    ...settings,
    delayMinutes: Number(settings.delayMinutes),
    additionalSteps: settings.additionalSteps.map((step) => ({
      ...step,
      delayMinutes: Number(step.delayMinutes),
    })),
  };
}

function scoringFormFromSettings(value = {}) {
  const settings = { ...DEFAULT_LEAD_SCORING, ...value };
  return {
    enabled: !!settings.enabled,
    inactivityMinutes: Number(settings.inactivityMinutes),
    maxConversationMinutes: Number(settings.maxConversationMinutes),
    maxMessages: Number(settings.maxMessages),
  };
}

function commentFormFromSettings(value = {}) {
  const settings = { ...DEFAULT_COMMENT_AUTOMATION, ...value };
  return {
    enabled: !!settings.enabled,
    facebookEnabled: settings.facebookEnabled !== false,
    instagramEnabled: settings.instagramEnabled !== false,
    publicReplyEnabled: settings.publicReplyEnabled !== false,
    privateReplyEnabled: settings.privateReplyEnabled !== false,
    publicReplyStyle: settings.publicReplyStyle === "fixed" ? "fixed" : "ai",
    fixedPublicReply: settings.fixedPublicReply || DEFAULT_COMMENT_AUTOMATION.fixedPublicReply,
    skipEmojiOnly: settings.skipEmojiOnly !== false,
    skipNestedReplies: settings.skipNestedReplies !== false,
  };
}

function toolFromQuery(value) {
  if (value === "comment-automation") return "commentAutomation";
  if (value === "lead-temperature") return "leadScoring";
  if (value === "lead-distribution") return "leadDistribution";
  return "followUp";
}

function queryForTool(tool) {
  if (tool === "commentAutomation") return "comment-automation";
  if (tool === "leadScoring") return "lead-temperature";
  if (tool === "leadDistribution") return "lead-distribution";
  return "";
}

export default function Tools() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTool = toolFromQuery(searchParams.get("tool"));
  const [config, setConfig] = useState(null);
  const [form, setForm] = useState(DEFAULT_FOLLOW_UP);
  const [scoringForm, setScoringForm] = useState(DEFAULT_LEAD_SCORING);
  const [commentForm, setCommentForm] = useState(DEFAULT_COMMENT_AUTOMATION);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [scoringSaving, setScoringSaving] = useState(false);
  const [commentSaving, setCommentSaving] = useState(false);
  const [commentChannelStatus, setCommentChannelStatus] = useState(null);
  const [commentStatusLoading, setCommentStatusLoading] = useState(false);
  const [commentStatusError, setCommentStatusError] = useState("");
  const [translating, setTranslating] = useState(false);
  const [translationLanguage, setTranslationLanguage] = useState("en");
  const [translationsSource, setTranslationsSource] = useState(DEFAULT_FOLLOW_UP.message);
  const [manualTranslationEdits, setManualTranslationEdits] = useState([]);
  const [reviewTranslations, setReviewTranslations] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [uploadingVideo, setUploadingVideo] = useState(false);
  const [distributionDirty, setDistributionDirty] = useState(false);
  const [distributionActive, setDistributionActive] = useState(false);
  const { user } = useAuth();
  const { toasts, showToast, dismissToast } = useToasts();

  useEffect(() => {
    let cancelled = false;
    api
      .getConfig()
      .then((data) => {
        if (cancelled) return;
        const followUp = followUpFormFromSettings(data.automatedFollowUp);
        const scoring = scoringFormFromSettings(data.leadScoring);
        const comments = commentFormFromSettings(data.commentAutomation);
        setConfig(data);
        setForm(followUp);
        setScoringForm(scoring);
        setCommentForm(comments);
        setTranslationsSource(followUp.message);
        setManualTranslationEdits([]);
        setDistributionActive(Boolean(data.leadDistribution?.enabled));
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err.message || "Failed to load tools.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loadCommentChannelStatus = useCallback(async () => {
    setCommentStatusLoading(true);
    setCommentStatusError("");
    try {
      const status = await api.getCommentAutomationStatus();
      setCommentChannelStatus(status);
      return status;
    } catch (err) {
      setCommentStatusError(err.message || "Couldn't load channel status.");
      return null;
    } finally {
      setCommentStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTool !== "commentAutomation") return;
    loadCommentChannelStatus();
  }, [activeTool, loadCommentChannelStatus]);

  const savedSettings = normalizeFollowUpSettings(config?.automatedFollowUp);
  const savedEnabled = !!savedSettings.enabled;
  const savedScoring = { ...DEFAULT_LEAD_SCORING, ...(config?.leadScoring || {}) };
  const hasUnsavedScoringChanges =
    scoringForm.enabled !== !!savedScoring.enabled ||
    Number(scoringForm.inactivityMinutes) !== Number(savedScoring.inactivityMinutes) ||
    Number(scoringForm.maxConversationMinutes) !== Number(savedScoring.maxConversationMinutes) ||
    Number(scoringForm.maxMessages) !== Number(savedScoring.maxMessages);
  const savedCommentSettings = commentFormFromSettings(config?.commentAutomation);
  const hasUnsavedCommentChanges =
    Object.keys(DEFAULT_COMMENT_AUTOMATION).some(
      (key) => key !== "activatedAt" && commentForm[key] !== savedCommentSettings[key]
    );
  const hasUnsavedChanges =
    JSON.stringify(comparableFollowUp(form)) !==
    JSON.stringify(comparableFollowUp(config?.automatedFollowUp));
  const translationsNeedRefresh =
    form.message.trim() !== translationsSource || !hasCompleteTranslations(form.translations);
  const translationReadyCount = FOLLOW_UP_LANGUAGES.filter(({ key }) => form.translations[key]?.trim()).length;
  const activeLanguage = FOLLOW_UP_LANGUAGES.find(({ key }) => key === translationLanguage);

  function currentToolHasUnsavedChanges() {
    if (activeTool === "followUp") return hasUnsavedChanges;
    if (activeTool === "commentAutomation") return hasUnsavedCommentChanges;
    if (activeTool === "leadScoring") return hasUnsavedScoringChanges;
    if (activeTool === "leadDistribution") return distributionDirty;
    return false;
  }

  function discardCurrentToolChanges() {
    if (activeTool === "followUp") {
      const saved = followUpFormFromSettings(config?.automatedFollowUp);
      setForm(saved);
      setTranslationsSource(saved.message);
      setManualTranslationEdits([]);
      setReviewTranslations(false);
      setTranslationLanguage("en");
      return;
    }
    if (activeTool === "commentAutomation") {
      setCommentForm(commentFormFromSettings(config?.commentAutomation));
      return;
    }
    if (activeTool === "leadScoring") {
      setScoringForm(scoringFormFromSettings(config?.leadScoring));
      return;
    }
    if (activeTool === "leadDistribution") {
      setDistributionDirty(false);
    }
  }

  function selectTool(tool) {
    if (tool === activeTool) return;
    if (currentToolHasUnsavedChanges()) {
      const leave = window.confirm("You have unsaved changes in this tool. Leave without saving them?");
      if (!leave) return;
      discardCurrentToolChanges();
    }
    const next = new URLSearchParams(searchParams);
    const queryValue = queryForTool(tool);
    if (queryValue) next.set("tool", queryValue);
    else next.delete("tool");
    setSearchParams(next, { replace: true });
  }

  const handleDistributionDirty = useCallback((dirty) => {
    setDistributionDirty(Boolean(dirty));
  }, []);

  const handleDistributionSavedStatus = useCallback((enabled) => {
    setDistributionActive(Boolean(enabled));
  }, []);

  async function requestTranslations(message, { announce = true } = {}) {
    setTranslating(true);
    try {
      const { translations } = await api.translateFollowUp(message);
      if (announce) showToast("Language versions updated.", "info");
      return translations;
    } catch (err) {
      showToast(err.message || "Couldn't generate the language versions.", "error");
      return null;
    } finally {
      setTranslating(false);
    }
  }

  async function requestTranslationBatch(messages) {
    const uniqueMessages = [
      ...new Set(
        messages
          .map((message) => String(message || "").trim())
          .filter(Boolean)
      ),
    ];
    if (!uniqueMessages.length) return new Map();

    setTranslating(true);
    try {
      const generatedByMessage = new Map();
      const chunkSize = 20;
      for (let start = 0; start < uniqueMessages.length; start += chunkSize) {
        const chunk = uniqueMessages.slice(start, start + chunkSize);
        const { translations } = await api.translateFollowUps(chunk);
        if (!Array.isArray(translations) || translations.length !== chunk.length) {
          throw new Error("The translation batch was incomplete.");
        }
        chunk.forEach((message, index) => {
          generatedByMessage.set(message, translations[index]);
        });
      }
      return generatedByMessage;
    } finally {
      setTranslating(false);
    }
  }

  async function handleGenerateTranslations() {
    const message = form.message.trim();
    if (!message) {
      showToast("Add the follow-up message first.", "error");
      return;
    }
    const translations = await requestTranslations(message);
    if (!translations) return;
    setForm((current) => ({ ...current, translations }));
    setTranslationsSource(message);
    setManualTranslationEdits([]);
  }

  async function generateTranslationsForMessage(message) {
    const source = String(message || "").trim();
    if (!source) {
      showToast("Add the message first.", "error");
      return null;
    }
    return requestTranslations(source, { announce: false });
  }

  function handleSourceMessageChange(value) {
    setForm((current) => ({ ...current, message: value }));
    // Any translation edits made before a source-message change belong to the
    // previous source. Only edits made after the latest source change should
    // be preserved when Save auto-generates fresh versions.
    setManualTranslationEdits([]);
  }

  function handleTranslationChange(languageKey, value) {
    setForm((current) => ({
      ...current,
      translations: { ...current.translations, [languageKey]: value },
    }));
    setManualTranslationEdits((current) =>
      current.includes(languageKey) ? current : [...current, languageKey]
    );
  }

  async function uploadFollowUpImage(file) {
    if (!file) return null;
    if (!FOLLOW_UP_IMAGE_TYPES.has(file.type)) {
      showToast("Please choose a JPG or PNG image.", "error");
      return null;
    }
    if (file.size > MAX_FOLLOW_UP_IMAGE_BYTES) {
      showToast("That image is larger than 5MB. Please choose a smaller file.", "error");
      return null;
    }

    setUploadingImage(true);
    try {
      const { url } = await api.uploadFollowUpImage(file);
      return url;
    } catch (err) {
      showToast(err.message || "Couldn't upload that image.", "error");
      return null;
    } finally {
      setUploadingImage(false);
    }
  }

  async function uploadFollowUpVideo(file) {
    if (!file) return null;
    const extension = String(file.name || "").toLowerCase().split(".").pop() || "";
    const mimeType = String(file.type || "").toLowerCase();
    if (
      extension !== "mp4" ||
      (mimeType && mimeType !== "application/octet-stream" && !mimeType.startsWith("video/"))
    ) {
      showToast("Please choose an MP4 video. WhatsApp requires H.264 video with AAC audio.", "error");
      return null;
    }
    if (file.size > MAX_FOLLOW_UP_VIDEO_BYTES) {
      showToast("That video is larger than 16MB. Please compress or export it before uploading.", "error");
      return null;
    }

    setUploadingVideo(true);
    try {
      return await api.uploadFollowUpVideo(file);
    } catch (err) {
      showToast(err.message || "Couldn't upload that video.", "error");
      return null;
    } finally {
      setUploadingVideo(false);
    }
  }

  function followUpValidationError() {
    const quietTimePattern = /^([01]\d|2[0-3]):([0-5]\d)$/;
    const quietStart = String(form.quietHours?.start || "").trim();
    const quietEnd = String(form.quietHours?.end || "").trim();
    if (
      !quietTimePattern.test(quietStart) ||
      !quietTimePattern.test(quietEnd) ||
      quietStart === quietEnd
    ) {
      return "Choose two different valid times for follow-up quiet hours.";
    }

    const steps = [
      {
        delayMinutes: form.delayMinutes,
        timingMode: form.timingMode,
        beforeWindowExpiryMinutes: form.beforeWindowExpiryMinutes,
        messageMode: form.messageMode,
        aiInstruction: form.aiInstruction,
        message: form.message,
        imageUrl: form.imageUrl,
        videoKey: form.videoKey,
        serviceOverrides: form.serviceOverrides,
      },
      ...(form.additionalSteps || []),
    ];
    if (steps.length > 3) return "You can configure up to 3 follow-ups.";

    const configuredServices = new Set(
      (config?.services || [])
        .map((service) => String(service?.name || "").trim().toLocaleLowerCase())
        .filter(Boolean)
    );
    let previousDelay = 0;
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      const timingMode =
        step.timingMode === "before_window_expiry"
          ? "before_window_expiry"
          : "after_reply";
      const beforeWindowExpiryMinutes = Number(
        step.beforeWindowExpiryMinutes ?? 120
      );
      const delayMinutes =
        timingMode === "before_window_expiry"
          ? 24 * 60 - beforeWindowExpiryMinutes
          : Number(step.delayMinutes);
      const messageMode = step.messageMode === "ai" ? "ai" : "fixed";
      const aiInstruction = String(step.aiInstruction || "").trim();
      const message = String(step.message || "").trim();
      if (String(step.imageUrl || "").trim() && String(step.videoKey || "").trim()) {
        return `Follow-up ${index + 1} can use either an image or a video, not both.`;
      }
      if (
        timingMode === "before_window_expiry" &&
        (
          !Number.isInteger(beforeWindowExpiryMinutes) ||
          beforeWindowExpiryMinutes < 60 ||
          beforeWindowExpiryMinutes > 360
        )
      ) {
        return `Follow-up ${index + 1} needs an expiry offset between 1 and 6 hours.`;
      }
      if (
        !Number.isInteger(delayMinutes) ||
        delayMinutes < 5 ||
        delayMinutes > 1380
      ) {
        return `Follow-up ${index + 1} needs a delay between 5 minutes and 23 hours.`;
      }
      if (index > 0 && delayMinutes <= previousDelay) {
        return `Follow-up ${index + 1} must be later than Follow-up ${index}.`;
      }
      if (!["fixed", "ai"].includes(messageMode)) {
        return `Choose a message type for Follow-up ${index + 1}.`;
      }
      if (aiInstruction.length > 1000) {
        return `Keep the AI instruction for Follow-up ${index + 1} under 1,000 characters.`;
      }
      if (!message) {
        return messageMode === "ai"
          ? `Add a fallback message for Follow-up ${index + 1}.`
          : `Add a message for Follow-up ${index + 1}.`;
      }
      if (message.length > 1000) {
        return `Keep Follow-up ${index + 1} under 1,000 characters.`;
      }

      const seenServices = new Set();
      for (const override of step.serviceOverrides || []) {
        const serviceName = String(override?.serviceName || "").trim();
        const targetedMessage = String(override?.message || "").trim();
        if (!serviceName || !targetedMessage) {
          return `Complete every targeted service message in Follow-up ${index + 1}.`;
        }
        if (!configuredServices.has(serviceName.toLocaleLowerCase())) {
          return `${serviceName} is no longer in Services. Remap or remove that targeted follow-up.`;
        }
        if (targetedMessage.length > 1000) {
          return `Keep targeted messages in Follow-up ${index + 1} under 1,000 characters.`;
        }
        if (String(override.imageUrl || "").trim() && String(override.videoKey || "").trim()) {
          return `${serviceName} in Follow-up ${index + 1} can use either an image or a video, not both.`;
        }
        const serviceKey = serviceName.toLocaleLowerCase();
        if (seenServices.has(serviceKey)) {
          return `${serviceName} is targeted more than once in Follow-up ${index + 1}.`;
        }
        seenServices.add(serviceKey);
      }
      previousDelay = delayMinutes;
    }
    return "";
  }

  function trimmedTranslations(value = {}) {
    return Object.fromEntries(
      FOLLOW_UP_LANGUAGES.map(({ key }) => [
        key,
        String(value?.[key] || "").trim(),
      ])
    );
  }

  function missingTranslationMessages() {
    const messages = [];
    const firstMessage = form.message.trim();
    if (translationsNeedRefresh) messages.push(firstMessage);

    const collectOverrides = (overrides = []) => {
      for (const item of overrides) {
        if (!hasCompleteTranslations(item.translations)) {
          messages.push(String(item.message || "").trim());
        }
      }
    };

    collectOverrides(form.serviceOverrides);
    for (const step of form.additionalSteps || []) {
      if (!hasCompleteTranslations(step.translations)) {
        messages.push(String(step.message || "").trim());
      }
      collectOverrides(step.serviceOverrides);
    }
    return messages.filter(Boolean);
  }

  function preparedServiceOverrides(overrides, generatedByMessage) {
    return (overrides || []).map((item) => {
      const message = item.message.trim();
      const existingTranslations = trimmedTranslations(item.translations);
      const generated = hasCompleteTranslations(item.translations)
        ? null
        : generatedByMessage.get(message);
      if (!hasCompleteTranslations(item.translations) && !generated) {
        throw new Error("Couldn't generate targeted language versions.");
      }
      const translations = Object.fromEntries(
        FOLLOW_UP_LANGUAGES.map(({ key }) => [
          key,
          existingTranslations[key] || generated?.[key] || "",
        ])
      );
      return {
        serviceName: item.serviceName.trim(),
        message,
        translations,
        imageUrl: String(item.imageUrl || "").trim(),
        videoKey: String(item.videoKey || "").trim(),
        videoFilename: String(item.videoFilename || "").trim(),
      };
    });
  }

  function preparedAdditionalSteps(steps, generatedByMessage) {
    return (steps || []).map((step) => {
      const message = step.message.trim();
      const existingTranslations = trimmedTranslations(step.translations);
      const generated = hasCompleteTranslations(step.translations)
        ? null
        : generatedByMessage.get(message);
      if (!hasCompleteTranslations(step.translations) && !generated) {
        throw new Error("Couldn't generate sequence language versions.");
      }
      const translations = Object.fromEntries(
        FOLLOW_UP_LANGUAGES.map(({ key }) => [
          key,
          existingTranslations[key] || generated?.[key] || "",
        ])
      );
      const timingMode =
        step.timingMode === "before_window_expiry"
          ? "before_window_expiry"
          : "after_reply";
      const beforeWindowExpiryMinutes = Number(
        step.beforeWindowExpiryMinutes ?? 120
      );
      return {
        delayMinutes:
          timingMode === "before_window_expiry"
            ? 24 * 60 - beforeWindowExpiryMinutes
            : Number(step.delayMinutes),
        timingMode,
        beforeWindowExpiryMinutes,
        messageMode: step.messageMode === "ai" ? "ai" : "fixed",
        aiInstruction: String(step.aiInstruction || "").trim(),
        message,
        translations,
        imageUrl: step.imageUrl || "",
        videoKey: step.videoKey || "",
        videoFilename: step.videoFilename || "",
        serviceOverrides: preparedServiceOverrides(
          step.serviceOverrides,
          generatedByMessage
        ),
      };
    });
  }

  async function handleSave() {
    const validationError = followUpValidationError();
    if (validationError) {
      showToast(validationError, "error");
      return;
    }

    const delayMinutes = Number(form.delayMinutes);
    const message = form.message.trim();

    setSaving(true);
    try {
      const generatedByMessage = await requestTranslationBatch(
        missingTranslationMessages()
      );

      let translations = trimmedTranslations(form.translations);
      if (translationsNeedRefresh) {
        const generated = generatedByMessage.get(message);
        if (!generated) {
          throw new Error("Couldn't generate the main follow-up language versions.");
        }
        translations = Object.fromEntries(
          FOLLOW_UP_LANGUAGES.map(({ key }) => {
            const manualValue = form.translations[key]?.trim() || "";
            const preserveManual =
              manualTranslationEdits.includes(key) && manualValue;
            return [key, preserveManual ? manualValue : generated[key]];
          })
        );
      }

      const serviceOverrides = preparedServiceOverrides(
        form.serviceOverrides,
        generatedByMessage
      );
      const additionalSteps = preparedAdditionalSteps(
        form.additionalSteps,
        generatedByMessage
      );

      const updated = await api.updateConfig({
        automatedFollowUp: {
          enabled: form.enabled,
          delayMinutes:
            form.timingMode === "before_window_expiry"
              ? 24 * 60 - Number(form.beforeWindowExpiryMinutes || 120)
              : delayMinutes,
          timingMode:
            form.timingMode === "before_window_expiry"
              ? "before_window_expiry"
              : "after_reply",
          beforeWindowExpiryMinutes: Number(
            form.beforeWindowExpiryMinutes || 120
          ),
          messageMode: form.messageMode === "ai" ? "ai" : "fixed",
          aiInstruction: String(form.aiInstruction || "").trim(),
          triggerMode: form.triggerMode,
          quietHours: {
            enabled: form.quietHours?.enabled !== false,
            start: String(form.quietHours?.start || "00:00"),
            end: String(form.quietHours?.end || "07:00"),
          },
          message,
          translations,
          imageUrl: form.imageUrl,
          videoKey: form.videoKey,
          videoFilename: form.videoFilename,
          serviceOverrides,
          additionalSteps,
        },
      });
      const saved = followUpFormFromSettings(updated.automatedFollowUp);
      setConfig(updated);
      setForm(saved);
      setTranslationsSource(saved.message);
      setManualTranslationEdits([]);
      showToast(
        saved.enabled
          ? `Automated follow-up sequence is active (${1 + saved.additionalSteps.length} step${saved.additionalSteps.length ? "s" : ""}).`
          : "Automated follow-up is paused.",
        "info"
      );
    } catch (err) {
      showToast(err.message || "Couldn't save the follow-up tool.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveCommentAutomation() {
    if (commentForm.enabled && !commentForm.facebookEnabled && !commentForm.instagramEnabled) {
      showToast("Choose Facebook, Instagram, or both.", "error");
      return;
    }
    if (commentForm.enabled && !commentForm.publicReplyEnabled && !commentForm.privateReplyEnabled) {
      showToast("Enable a public reply, private message, or both.", "error");
      return;
    }
    const fixedPublicReply = commentForm.fixedPublicReply.trim();
    if (
      commentForm.publicReplyEnabled &&
      commentForm.publicReplyStyle === "fixed" &&
      (!fixedPublicReply || fixedPublicReply.length > 300)
    ) {
      showToast("Keep the fixed public reply between 1 and 300 characters.", "error");
      return;
    }

    setCommentSaving(true);
    try {
      const updated = await api.updateConfig({
        commentAutomation: {
          ...commentForm,
          fixedPublicReply,
        },
      });
      const saved = commentFormFromSettings(updated.commentAutomation);
      setConfig(updated);
      setCommentForm(saved);
      showToast(
        saved.enabled ? "Comment automation is active." : "Comment automation is paused.",
        "info"
      );
    } catch (err) {
      showToast(err.message || "Couldn't save comment automation.", "error");
    } finally {
      setCommentSaving(false);
    }
  }

  async function handleSaveScoring() {
    const inactivityMinutes = Number(scoringForm.inactivityMinutes);
    const maxConversationMinutes = Number(scoringForm.maxConversationMinutes);
    const maxMessages = Number(scoringForm.maxMessages);
    if (!Number.isInteger(inactivityMinutes) || inactivityMinutes < 5 || inactivityMinutes > 30) {
      showToast("Choose a quiet period between 5 and 30 minutes.", "error");
      return;
    }
    if (!Number.isInteger(maxConversationMinutes) || maxConversationMinutes < 30 || maxConversationMinutes > 120) {
      showToast("Choose a conversation limit between 30 and 120 minutes.", "error");
      return;
    }
    if (!Number.isInteger(maxMessages) || maxMessages < 20 || maxMessages > 80) {
      showToast("Choose a message limit between 20 and 80 messages.", "error");
      return;
    }

    setScoringSaving(true);
    try {
      const updated = await api.updateConfig({
        leadScoring: {
          enabled: scoringForm.enabled,
          inactivityMinutes,
          maxConversationMinutes,
          maxMessages,
        },
      });
      const saved = scoringFormFromSettings(updated.leadScoring);
      setConfig(updated);
      setScoringForm(saved);
      showToast(saved.enabled ? "Automatic lead temperature is active." : "Automatic lead temperature is paused.", "info");
    } catch (err) {
      showToast(err.message || "Couldn't save automatic lead temperature.", "error");
    } finally {
      setScoringSaving(false);
    }
  }

  if (loadError) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <p className="text-sm text-[var(--color-danger)]">Couldn't load tools: {loadError}</p>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="h-6 w-6 text-[var(--color-text-muted)]" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-[var(--color-bg)] xl:flex-row">
      <ToolsSidebar
        activeTool={activeTool}
        onSelect={selectTool}
        followUpActive={savedEnabled}
        commentActive={!!savedCommentSettings.enabled}
        scoringActive={!!savedScoring.enabled}
        distributionActive={distributionActive}
      />

      <div className="min-h-0 min-w-0 flex-1">
        {activeTool === "followUp" && (
          <FollowUpTool
            form={form}
            setForm={setForm}
            savedEnabled={savedEnabled}
            hasUnsavedChanges={hasUnsavedChanges}
            translationsNeedRefresh={translationsNeedRefresh}
            translationReadyCount={translationReadyCount}
            reviewTranslations={reviewTranslations}
            setReviewTranslations={setReviewTranslations}
            translationLanguage={translationLanguage}
            setTranslationLanguage={setTranslationLanguage}
            activeLanguage={activeLanguage}
            translating={translating}
            uploadingImage={uploadingImage}
            uploadingVideo={uploadingVideo}
            saving={saving}
            services={config.services || []}
            promotions={config.promotions || []}
            onSourceMessageChange={handleSourceMessageChange}
            onTranslationChange={handleTranslationChange}
            onGenerateTranslations={handleGenerateTranslations}
            onTranslateMessage={generateTranslationsForMessage}
            onUploadImage={uploadFollowUpImage}
            onUploadVideo={uploadFollowUpVideo}
            onSave={handleSave}
            toasts={toasts}
            dismissToast={dismissToast}
          />
        )}

        {activeTool === "commentAutomation" && (
          <CommentAutomationTool
            form={commentForm}
            setForm={setCommentForm}
            savedEnabled={!!savedCommentSettings.enabled}
            hasUnsavedChanges={hasUnsavedCommentChanges}
            saving={commentSaving}
            channelStatus={commentChannelStatus}
            isAdmin={user?.role === "admin"}
            statusLoading={commentStatusLoading}
            statusError={commentStatusError}
            onRefreshStatus={loadCommentChannelStatus}
            onSave={handleSaveCommentAutomation}
            toasts={toasts}
            dismissToast={dismissToast}
          />
        )}

        {activeTool === "leadScoring" && (
          <LeadScoringTool
            form={scoringForm}
            setForm={setScoringForm}
            savedEnabled={!!savedScoring.enabled}
            hasUnsavedChanges={hasUnsavedScoringChanges}
            saving={scoringSaving}
            onSave={handleSaveScoring}
            toasts={toasts}
            dismissToast={dismissToast}
          />
        )}

        {activeTool === "leadDistribution" && (
          <LeadDistribution
            onDirtyChange={handleDistributionDirty}
            onSavedStatus={handleDistributionSavedStatus}
          />
        )}
      </div>
    </div>
  );
}

function nextSequenceDelay(previousDelay) {
  const previous = Number(previousDelay);
  const preferred = [480, 1200, 1320, 1380].find(
    (minutes) => minutes > previous
  );
  if (preferred) return preferred;
  return previous < 1380 ? Math.min(1380, previous + 5) : null;
}

function TranslationDetails({
  sourceMessage,
  translations = {},
  onChange,
  onReplace,
  onTranslate,
  translating,
}) {
  const [languageKey, setLanguageKey] = useState("en");
  const language = FOLLOW_UP_LANGUAGES.find((item) => item.key === languageKey);
  const readyCount = FOLLOW_UP_LANGUAGES.filter(
    ({ key }) => String(translations?.[key] || "").trim()
  ).length;

  async function regenerate() {
    const generated = await onTranslate(sourceMessage);
    if (generated) onReplace(generated);
  }

  return (
    <details className="mt-3 rounded-xl border border-[var(--color-border)] bg-white">
      <summary className="cursor-pointer list-none px-3.5 py-3 text-xs font-semibold text-[var(--color-primary)]">
        Review translations · {readyCount}/3 ready
      </summary>
      <div className="border-t border-[var(--color-border)] p-3.5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[10px] leading-4 text-[var(--color-text-muted)]">
            English, BM and Chinese are selected automatically for each customer. You can fine-tune any version here.
          </p>
          <button
            type="button"
            onClick={regenerate}
            disabled={translating || !String(sourceMessage || "").trim()}
            className="shrink-0 rounded-lg border border-[var(--color-primary)]/25 px-2.5 py-1.5 text-[10px] font-semibold text-[var(--color-primary)] disabled:opacity-50"
          >
            {translating ? "Generating…" : "Regenerate"}
          </button>
        </div>
        <div className="mt-3 flex gap-1 overflow-x-auto border-b border-[var(--color-border)]">
          {FOLLOW_UP_LANGUAGES.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setLanguageKey(item.key)}
              className={`shrink-0 border-b-2 px-2.5 py-2 text-[10px] font-semibold ${languageKey === item.key ? "border-[var(--color-primary)] text-[var(--color-primary)]" : "border-transparent text-[var(--color-text-muted)]"}`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <label className="text-[10px] font-semibold">{language?.label} message</label>
          <span className="text-[10px] text-[var(--color-text-muted)]">
            {String(translations?.[languageKey] || "").length}/1000
          </span>
        </div>
        <textarea
          rows="3"
          maxLength="1000"
          value={translations?.[languageKey] || ""}
          onChange={(event) => onChange(languageKey, event.target.value)}
          className="mt-1.5 w-full resize-y rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2.5 text-xs leading-5 outline-none focus:border-[var(--color-primary)]"
        />
      </div>
    </details>
  );
}

function FollowUpMessageMode({
  mode = "fixed",
  instruction = "",
  onChange,
}) {
  const normalizedMode = mode === "ai" ? "ai" : "fixed";
  const options = [
    {
      key: "fixed",
      title: "Fixed message",
      description: "Always use the reviewed message you write below.",
    },
    {
      key: "ai",
      title: "AI personalized",
      description: "Review the recent chat and write a useful continuation when a follow-up makes sense.",
    },
  ];

  return (
    <div className="mt-5">
      <div>
        <p className="text-sm font-semibold">Message type</p>
        <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
          AI mode can send, skip, or flag a conversation for staff. If AI generation fails, the fixed fallback message is used.
        </p>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Follow-up message type">
        {options.map((option) => {
          const selected = normalizedMode === option.key;
          return (
            <button
              key={option.key}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange({ messageMode: option.key })}
              className={`rounded-xl border px-3.5 py-3 text-left transition ${selected ? "border-[var(--color-primary)] bg-white ring-2 ring-[var(--color-primary-light)]" : "border-[var(--color-border)] bg-white hover:border-[var(--color-primary)]/35"}`}
            >
              <div className="flex items-center gap-2">
                <span className={`h-3.5 w-3.5 rounded-full border ${selected ? "border-[var(--color-primary)] bg-[var(--color-primary)] shadow-[inset_0_0_0_3px_white]" : "border-[var(--color-border-strong)]"}`} />
                <span className="text-xs font-semibold">{option.title}</span>
              </div>
              <p className="mt-1.5 pl-5 text-[10px] leading-4 text-[var(--color-text-muted)]">
                {option.description}
              </p>
            </button>
          );
        })}
      </div>

      {normalizedMode === "ai" && (
        <div className="mt-4 border-t border-[var(--color-border)] pt-4">
          <div className="flex items-center justify-between gap-3">
            <label className="text-xs font-semibold">Optional AI instruction</label>
            <span className="text-[10px] text-[var(--color-text-muted)]">{instruction.length}/1000</span>
          </div>
          <textarea
            rows="3"
            maxLength="1000"
            value={instruction}
            onChange={(event) => onChange({ aiInstruction: event.target.value })}
            placeholder="Example: Gently guide interested customers toward booking an assessment. Do not push if they are still comparing options."
            className="mt-1.5 w-full resize-y rounded-xl border border-[var(--color-border)] bg-white px-3.5 py-3 text-sm leading-6 outline-none focus:border-[var(--color-primary)]"
          />
          <p className="mt-1.5 text-[10px] leading-4 text-[var(--color-text-muted)]">
            The AI still follows your current services, promotions, SOP and guardrails. This only guides the follow-up angle.
          </p>
        </div>
      )}
    </div>
  );
}

function StepImagePicker({
  imageUrl,
  uploading,
  onUpload,
  onChange,
  label = "Optional graphic",
}) {
  const inputRef = useRef(null);

  async function handlePicked(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const url = await onUpload(file);
    if (url) onChange(url);
  }

  return (
    <div className="mt-4 rounded-xl border border-[var(--color-border)] bg-white p-3.5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold">{label}</p>
          <p className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">JPG or PNG, up to 5MB.</p>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png"
          aria-label={`${label} upload`}
          className="hidden"
          onChange={handlePicked}
        />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="rounded-lg border border-[var(--color-primary)]/25 px-2.5 py-1.5 text-[10px] font-semibold text-[var(--color-primary)] disabled:opacity-50"
        >
          {uploading ? "Uploading…" : imageUrl ? "Replace" : "Add image"}
        </button>
      </div>
      {imageUrl && (
        <div className="mt-3 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)]">
          <img src={imageUrl} alt="" className="max-h-48 w-full object-contain" />
          <div className="flex justify-end border-t border-[var(--color-border)] bg-white px-3 py-2">
            <button
              type="button"
              onClick={() => onChange("")}
              disabled={uploading}
              className="text-[10px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-danger)] disabled:opacity-50"
            >
              Remove image
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function FollowUpTimingFields({
  step,
  onChange,
  label = "Send timing",
  compact = false,
}) {
  const timingMode =
    step?.timingMode === "before_window_expiry"
      ? "before_window_expiry"
      : "after_reply";
  const beforeWindowExpiryMinutes = Number(
    step?.beforeWindowExpiryMinutes || 120
  );

  return (
    <div>
      <label className={compact ? "text-xs font-semibold" : "text-sm font-semibold"}>
        {label}
      </label>
      <select
        value={timingMode}
        onChange={(event) => {
          const nextMode = event.target.value;
          if (nextMode === "before_window_expiry") {
            onChange({
              timingMode: "before_window_expiry",
              beforeWindowExpiryMinutes: 120,
              delayMinutes: 1320,
            });
          } else {
            onChange({
              timingMode: "after_reply",
              delayMinutes: 120,
            });
          }
        }}
        className="mt-1.5 w-full rounded-xl border border-[var(--color-border)] bg-white px-3 py-2.5 text-sm outline-none focus:border-[var(--color-primary)]"
      >
        <option value="after_reply">After the latest AI/staff reply</option>
        <option value="before_window_expiry">Before messaging window expires</option>
      </select>

      {timingMode === "before_window_expiry" ? (
        <div className="mt-2">
          <select
            value={beforeWindowExpiryMinutes}
            onChange={(event) => {
              const minutes = Number(event.target.value);
              onChange({
                beforeWindowExpiryMinutes: minutes,
                delayMinutes: 24 * 60 - minutes,
              });
            }}
            className="w-full rounded-xl border border-[var(--color-border)] bg-white px-3 py-2.5 text-sm outline-none focus:border-[var(--color-primary)]"
          >
            <option value="60">1 hour before expiry</option>
            <option value="120">2 hours before expiry</option>
            <option value="180">3 hours before expiry</option>
            <option value="240">4 hours before expiry</option>
            <option value="360">6 hours before expiry</option>
          </select>
          <p className="mt-1.5 text-[10px] leading-4 text-[var(--color-text-muted)]">
            Uses the customer's latest inbound message. A newer customer reply resets the window and this timing automatically.
          </p>
        </div>
      ) : (
        <div className="mt-2">
          <div className="flex items-center overflow-hidden rounded-xl border border-[var(--color-border)] bg-white focus-within:border-[var(--color-primary)]">
            <input
              type="number"
              min="5"
              max="1380"
              step="1"
              value={step?.delayMinutes ?? 120}
              onChange={(event) =>
                onChange({ delayMinutes: event.target.value })
              }
              className="min-w-0 flex-1 bg-transparent px-3 py-2.5 text-sm outline-none"
            />
            <span className="border-l border-[var(--color-border)] px-2.5 py-2.5 text-[10px] text-[var(--color-text-muted)]">
              min
            </span>
          </div>
          <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">
            {formatDelay(Number(step?.delayMinutes || 0))} after the original reply
          </p>
        </div>
      )}
    </div>
  );
}

function ServiceVideoPicker({
  videoKey,
  videoFilename,
  uploading,
  onUpload,
  onChange,
  label = "Video",
  description = "Optional MP4 attachment.",
}) {
  const inputRef = useRef(null);

  async function handlePicked(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const uploaded = await onUpload(file);
    if (uploaded?.key) onChange(uploaded);
  }

  return (
    <div className="mt-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold">{label}</p>
          <p className="mt-0.5 truncate text-[10px] text-[var(--color-text-muted)]">
            {videoKey ? videoFilename || "MP4 video attached" : description}
          </p>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".mp4,video/*"
          className="hidden"
          aria-label={`${label} upload`}
          onChange={handlePicked}
        />
        <div className="flex shrink-0 gap-3">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
            className="text-[10px] font-semibold text-[var(--color-primary)] disabled:opacity-50"
          >
            {uploading ? "Checking…" : videoKey ? "Replace" : "Add video"}
          </button>
          {videoKey && (
            <button
              type="button"
              onClick={() => onChange({ key: "", filename: "" })}
              disabled={uploading}
              className="text-[10px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-danger)] disabled:opacity-50"
            >
              Remove
            </button>
          )}
        </div>
      </div>
      <p className="mt-2 text-[10px] leading-4 text-[var(--color-text-muted)]">
        MP4 only, up to 16MB. WhatsApp requires H.264 video with AAC audio. Automatic video compression is disabled to keep the chatbot server stable.
      </p>
    </div>
  );
}

function FollowUpMediaPicker({
  imageUrl,
  videoKey,
  videoFilename,
  uploadingImage,
  uploadingVideo,
  onUploadImage,
  onUploadVideo,
  onChange,
  label = "Media",
  description = "Optional. Attach one image or one MP4 video.",
}) {
  const initialType = videoKey ? "video" : imageUrl ? "image" : "none";
  const [selectedType, setSelectedType] = useState(initialType);

  useEffect(() => {
    if (videoKey) setSelectedType("video");
    else if (imageUrl) setSelectedType("image");
  }, [imageUrl, videoKey]);

  function choose(type) {
    setSelectedType(type);
    if (type === "none") {
      onChange({ imageUrl: "", videoKey: "", videoFilename: "" });
      return;
    }
    if (type === "image" && videoKey) {
      onChange({ imageUrl: "", videoKey: "", videoFilename: "" });
    }
    if (type === "video" && imageUrl) {
      onChange({ imageUrl: "", videoKey: "", videoFilename: "" });
    }
  }

  return (
    <div className="mt-5 border-t border-[var(--color-border)] pt-5">
      <div>
        <p className="text-sm font-semibold">{label}</p>
        <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">{description}</p>
      </div>

      <div
        className="mt-3 grid grid-cols-3 gap-1 rounded-xl border border-[var(--color-border)] bg-white p-1"
        role="radiogroup"
        aria-label={`${label} type`}
      >
        {[
          ["none", "No media"],
          ["image", "Image"],
          ["video", "Video"],
        ].map(([type, text]) => {
          const active = selectedType === type;
          return (
            <button
              key={type}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => choose(type)}
              disabled={uploadingImage || uploadingVideo}
              className={`rounded-lg px-2 py-2 text-[11px] font-semibold transition sm:text-xs ${active
                ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]"
                : "text-[var(--color-text-muted)] hover:bg-[var(--color-bg)]"}`}
            >
              {text}
            </button>
          );
        })}
      </div>

      {selectedType === "image" && (
        <StepImagePicker
          imageUrl={imageUrl}
          uploading={uploadingImage}
          onUpload={onUploadImage}
          onChange={(nextImageUrl) =>
            onChange({
              imageUrl: nextImageUrl,
              videoKey: "",
              videoFilename: "",
            })
          }
          label={`${label} image`}
        />
      )}

      {selectedType === "video" && (
        <ServiceVideoPicker
          videoKey={videoKey}
          videoFilename={videoFilename}
          uploading={uploadingVideo}
          onUpload={onUploadVideo}
          onChange={({ key, filename }) =>
            onChange({
              imageUrl: "",
              videoKey: key,
              videoFilename: filename,
            })
          }
          label={`${label} video`}
          description="MP4 attachment. Large files are prepared automatically."
        />
      )}
    </div>
  );
}

function followUpTimingSummary(step) {
  return step?.timingMode === "before_window_expiry"
    ? `${formatDelay(Number(step?.beforeWindowExpiryMinutes || 120))} before window expiry`
    : formatDelay(Number(step?.delayMinutes || 0));
}

function StepSummaryChips({ step }) {
  const serviceCount = Array.isArray(step?.serviceOverrides)
    ? step.serviceOverrides.length
    : 0;
  const chips = [
    ...(step?.messageMode === "ai" ? ["AI"] : []),
    ...(step?.videoKey ? ["Video"] : step?.imageUrl ? ["Image"] : []),
    ...(serviceCount ? [`${serviceCount} service${serviceCount === 1 ? "" : "s"}`] : []),
  ];

  if (!chips.length) return null;

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {chips.map((chip) => (
        <span
          key={chip}
          className="rounded-full border border-[var(--color-border)] bg-white px-2 py-0.5 text-[10px] font-semibold text-[var(--color-text-muted)]"
        >
          {chip}
        </span>
      ))}
    </div>
  );
}

function ServiceOverridesEditor({
  overrides = [],
  services = [],
  onChange,
  stepLabel,
  translating,
  uploadingImage,
  uploadingVideo,
  onUploadImage,
  onUploadVideo,
  onTranslateMessage,
}) {
  const [expanded, setExpanded] = useState(false);
  const serviceNames = services
    .map((service) => String(service?.name || "").trim())
    .filter(Boolean);
  const normalizedServices = new Set(
    serviceNames.map((name) => name.toLocaleLowerCase())
  );
  const selected = new Set(
    overrides.map((item) =>
      String(item?.serviceName || "").trim().toLocaleLowerCase()
    )
  );
  const available = serviceNames.filter(
    (name) => !selected.has(name.toLocaleLowerCase())
  );

  function addOverride() {
    if (!available.length) return;
    setExpanded(true);
    onChange([
      ...overrides,
      {
        serviceName: available[0],
        message: "",
        translations: { en: "", ms: "", zh: "" },
        imageUrl: "",
        videoKey: "",
        videoFilename: "",
      },
    ]);
  }

  return (
    <div className="mt-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)]">
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3.5 text-left"
        aria-expanded={expanded}
      >
        <div>
          <p className="text-sm font-semibold">
            Target by service
            <span className="ml-2 font-normal text-[var(--color-text-muted)]">
              Optional · {overrides.length} configured
            </span>
          </p>
          <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
            Use a more relevant message when exactly one service interest is clear.
          </p>
        </div>
        <span className="shrink-0 text-xs font-semibold text-[var(--color-primary)]">
          {expanded ? "Hide" : "Manage"}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-[var(--color-border)] p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs leading-5 text-[var(--color-text-muted)]">
              If interest is unclear or multiple services are being compared, the default {stepLabel} is used.
            </p>
            <button
              type="button"
              onClick={addOverride}
              disabled={!available.length}
              className="shrink-0 rounded-xl border border-[var(--color-primary)]/25 bg-white px-3 py-2 text-xs font-semibold text-[var(--color-primary)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              + Add service message
            </button>
          </div>

          {!serviceNames.length && (
            <p className="mt-3 rounded-xl border border-dashed border-[var(--color-border)] bg-white px-3 py-2.5 text-xs text-[var(--color-text-muted)]">
              Add services in Settings first. The default follow-up will still work for every lead.
            </p>
          )}

          {overrides.length > 0 && (
            <div className="mt-4 space-y-3">
              {overrides.map((item, index) => {
                const usedByOthers = new Set(
                  overrides
                    .filter((_, otherIndex) => otherIndex !== index)
                    .map((override) =>
                      String(override?.serviceName || "").trim().toLocaleLowerCase()
                    )
                );
                const choices = [
                  item.serviceName,
                  ...serviceNames.filter((name) => name !== item.serviceName),
                ].filter((name, choiceIndex, all) => name && all.indexOf(name) === choiceIndex);
                const stale = !normalizedServices.has(
                  String(item.serviceName || "").trim().toLocaleLowerCase()
                );

                return (
                  <div key={`${item.serviceName || "service"}-${index}`} className="rounded-xl border border-[var(--color-border)] bg-white p-3.5">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <select
                        value={item.serviceName}
                        onChange={(event) => {
                          const next = overrides.map((override, overrideIndex) =>
                            overrideIndex === index
                              ? { ...override, serviceName: event.target.value }
                              : override
                          );
                          onChange(next);
                        }}
                        className="min-w-0 flex-1 rounded-xl border border-[var(--color-border)] bg-white px-3 py-2.5 text-sm outline-none focus:border-[var(--color-primary)]"
                      >
                        {choices.map((name) => (
                          <option key={name} value={name} disabled={usedByOthers.has(name.toLocaleLowerCase())}>
                            {name}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() =>
                          onChange(overrides.filter((_, overrideIndex) => overrideIndex !== index))
                        }
                        className="self-start px-1 py-2 text-xs font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-danger)] sm:self-auto"
                      >
                        Remove
                      </button>
                    </div>
                    {stale && (
                      <p className="mt-2 text-[10px] font-semibold text-[var(--color-danger)]">
                        This service no longer exists. Choose a current service or remove this targeted message.
                      </p>
                    )}
                    <div className="mt-3 flex items-center justify-between gap-3">
                      <label className="text-xs font-semibold">Targeted message</label>
                      <span className="text-[10px] text-[var(--color-text-muted)]">{item.message.length}/1000</span>
                    </div>
                    <textarea
                      rows="3"
                      maxLength="1000"
                      value={item.message}
                      onChange={(event) => {
                        const next = overrides.map((override, overrideIndex) =>
                          overrideIndex === index
                            ? {
                                ...override,
                                message: event.target.value,
                                translations: { en: "", ms: "", zh: "" },
                              }
                            : override
                        );
                        onChange(next);
                      }}
                      placeholder="Write a more relevant follow-up for customers interested in this service."
                      className="mt-2 w-full resize-y rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3.5 py-3 text-sm leading-6 outline-none focus:border-[var(--color-primary)] focus:ring-2 focus:ring-[var(--color-primary-light)]"
                    />
                    <TranslationDetails
                      sourceMessage={item.message}
                      translations={item.translations}
                      translating={translating}
                      onTranslate={onTranslateMessage}
                      onReplace={(translations) =>
                        onChange(
                          overrides.map((override, overrideIndex) =>
                            overrideIndex === index
                              ? { ...override, translations }
                              : override
                          )
                        )
                      }
                      onChange={(languageKey, value) =>
                        onChange(
                          overrides.map((override, overrideIndex) =>
                            overrideIndex === index
                              ? {
                                  ...override,
                                  translations: {
                                    ...override.translations,
                                    [languageKey]: value,
                                  },
                                }
                              : override
                          )
                        )
                      }
                    />
                    <FollowUpMediaPicker
                      imageUrl={item.imageUrl}
                      videoKey={item.videoKey}
                      videoFilename={item.videoFilename}
                      uploadingImage={uploadingImage}
                      uploadingVideo={uploadingVideo}
                      onUploadImage={onUploadImage}
                      onUploadVideo={onUploadVideo}
                      onChange={(media) =>
                        onChange(
                          overrides.map((override, overrideIndex) =>
                            overrideIndex === index
                              ? { ...override, ...media }
                              : override
                          )
                        )
                      }
                      label="Service media"
                      description="Optional. Used only when this service is the clear current interest; otherwise the default follow-up media is used."
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FollowUpTool({
  form,
  setForm,
  savedEnabled,
  hasUnsavedChanges,
  translationsNeedRefresh,
  translationReadyCount,
  reviewTranslations,
  setReviewTranslations,
  translationLanguage,
  setTranslationLanguage,
  activeLanguage,
  translating,
  uploadingImage,
  uploadingVideo,
  saving,
  services,
  promotions,
  onSourceMessageChange,
  onTranslationChange,
  onGenerateTranslations,
  onTranslateMessage,
  onUploadImage,
  onUploadVideo,
  onSave,
  toasts,
  dismissToast,
}) {
  const [expandedStepIndex, setExpandedStepIndex] = useState(null);
  const [previewStepIndex, setPreviewStepIndex] = useState(0);
  const [previewServiceName, setPreviewServiceName] = useState("");
  const [mobilePreviewOpen, setMobilePreviewOpen] = useState(false);

  const allSteps = [
    {
      delayMinutes: form.delayMinutes,
      timingMode: form.timingMode,
      beforeWindowExpiryMinutes: form.beforeWindowExpiryMinutes,
      messageMode: form.messageMode,
      aiInstruction: form.aiInstruction,
      message: form.message,
      translations: form.translations,
      imageUrl: form.imageUrl,
      videoKey: form.videoKey,
      videoFilename: form.videoFilename,
      serviceOverrides: form.serviceOverrides,
    },
    ...(form.additionalSteps || []),
  ];
  const safePreviewIndex = Math.min(
    previewStepIndex,
    Math.max(0, allSteps.length - 1)
  );
  const previewStep = allSteps[safePreviewIndex] || allSteps[0];
  const previewOverride =
    (previewStep?.serviceOverrides || []).find(
      (item) => item.serviceName === previewServiceName
    ) || null;
  const previewCopySource = previewOverride || previewStep;
  const previewMediaSource =
    previewOverride && (previewOverride.imageUrl || previewOverride.videoKey)
      ? previewOverride
      : previewStep;
  const previewMessage =
    previewCopySource?.translations?.[translationLanguage] ||
    previewCopySource?.message ||
    "Your follow-up message will appear here.";
  const previewVideoUrl = previewMediaSource?.videoKey
    ? `/api/config/automated-follow-up/video-preview?key=${encodeURIComponent(previewMediaSource.videoKey)}`
    : "";
  const lastDelay = allSteps[allSteps.length - 1]?.delayMinutes;
  const suggestedNextDelay = nextSequenceDelay(lastDelay);
  const hasPromotionFollowUps = (Array.isArray(promotions) ? promotions : []).some(
    (promotion) =>
      String(promotion?.followUpMessage || "").trim() ||
      Object.values(promotion?.followUpTranslations || {}).some(
        (message) => String(message || "").trim()
      ) ||
      (Array.isArray(promotion?.packages) ? promotion.packages : []).some(
        (item) =>
          String(item?.followUpMessage || "").trim() ||
          Object.values(item?.followUpTranslations || {}).some(
            (message) => String(message || "").trim()
          )
      )
  );

  useEffect(() => {
    if (
      previewServiceName &&
      !(previewStep?.serviceOverrides || []).some(
        (item) => item.serviceName === previewServiceName
      )
    ) {
      setPreviewServiceName("");
    }
  }, [previewServiceName, previewStep]);

  function updateAdditionalStep(index, patch) {
    setForm((current) => ({
      ...current,
      additionalSteps: current.additionalSteps.map((step, stepIndex) =>
        stepIndex === index ? { ...step, ...patch } : step
      ),
    }));
  }

  function removeAdditionalStep(index) {
    setForm((current) => ({
      ...current,
      additionalSteps: current.additionalSteps.filter(
        (_, stepIndex) => stepIndex !== index
      ),
    }));
    setExpandedStepIndex(null);
    setPreviewStepIndex((current) =>
      current > index + 1 ? current - 1 : Math.min(current, index)
    );
  }

  return (
    <ToolShell
      title="Automated follow-up"
      description="Send a short sequence when a customer goes quiet, with optional service-specific messages."
      enabled={form.enabled}
      savedEnabled={savedEnabled}
      hasUnsavedChanges={hasUnsavedChanges}
      onToggle={() => setForm((current) => ({ ...current, enabled: !current.enabled }))}
      saveLabel="Save changes"
      saving={saving || translating}
      saveDisabled={
        saving ||
        translating ||
        uploadingImage ||
        uploadingVideo ||
        !hasUnsavedChanges
      }
      onSave={onSave}
      toasts={toasts}
      dismissToast={dismissToast}
    >
      {uploadingVideo && (
        <div
          role="status"
          className="mb-5 flex items-start gap-3 rounded-xl border border-[var(--color-primary)]/20 bg-[var(--color-primary-light)]/55 px-3.5 py-3"
        >
          <Spinner className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-primary)]" />
          <div>
            <p className="text-xs font-semibold text-[var(--color-primary)]">Preparing video…</p>
            <p className="mt-0.5 text-[11px] leading-4 text-[var(--color-text-muted)]">
              Large videos are uploaded and compressed automatically. Keep this page open until the attachment appears.
            </p>
          </div>
        </div>
      )}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.3fr)_minmax(19rem,0.7fr)]">
        <div className="order-2 space-y-5 xl:order-1">
          <Card>
            <SectionHeading
              number="1"
              title="Choose when it starts"
              description="Set the first follow-up timing, who can start a sequence, and when automation should stay quiet."
            />
            <div className="mt-6 grid gap-6 lg:grid-cols-2">
              <FollowUpTimingFields
                step={form}
                label="Follow-up 1 timing"
                onChange={(patch) =>
                  setForm((current) => ({ ...current, ...patch }))
                }
              />

              <fieldset>
                <legend className="text-sm font-semibold">Start the sequence after</legend>
                <div className="mt-2 space-y-2">
                  <Choice
                    checked={form.triggerMode === "all"}
                    label="Any outgoing message"
                    description="Messages sent by the AI or clinic staff can start the sequence."
                    onChange={() => setForm((current) => ({ ...current, triggerMode: "all" }))}
                  />
                  <Choice
                    checked={form.triggerMode === "staff"}
                    label="Staff messages only"
                    description="AI replies will not start a follow-up sequence."
                    onChange={() => setForm((current) => ({ ...current, triggerMode: "staff" }))}
                  />
                </div>
              </fieldset>
            </div>

            <div className="mt-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-semibold">Quiet hours</p>
                  <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
                    Do not send automated follow-ups while customers are likely sleeping. Uses the clinic timezone.
                  </p>
                </div>
                <Switch
                  checked={form.quietHours?.enabled !== false}
                  ariaLabel="Follow-up quiet hours"
                  onChange={() =>
                    setForm((current) => ({
                      ...current,
                      quietHours: {
                        ...(current.quietHours || DEFAULT_FOLLOW_UP.quietHours),
                        enabled: current.quietHours?.enabled === false,
                      },
                    }))
                  }
                />
              </div>

              {form.quietHours?.enabled !== false && (
                <div className="mt-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label htmlFor="follow-up-quiet-start" className="text-xs font-semibold">Quiet from</label>
                      <input
                        id="follow-up-quiet-start"
                        aria-label="Follow-up quiet hours start"
                        type="time"
                        value={form.quietHours?.start || "00:00"}
                        onChange={(event) =>
                          setForm((current) => ({
                            ...current,
                            quietHours: {
                              ...(current.quietHours || DEFAULT_FOLLOW_UP.quietHours),
                              start: event.target.value,
                            },
                          }))
                        }
                        className="mt-1.5 w-full rounded-xl border border-[var(--color-border)] bg-white px-3 py-2.5 text-sm outline-none focus:border-[var(--color-primary)]"
                      />
                    </div>
                    <div>
                      <label htmlFor="follow-up-quiet-end" className="text-xs font-semibold">Resume at</label>
                      <input
                        id="follow-up-quiet-end"
                        aria-label="Follow-up quiet hours end"
                        type="time"
                        value={form.quietHours?.end || "07:00"}
                        onChange={(event) =>
                          setForm((current) => ({
                            ...current,
                            quietHours: {
                              ...(current.quietHours || DEFAULT_FOLLOW_UP.quietHours),
                              end: event.target.value,
                            },
                          }))
                        }
                        className="mt-1.5 w-full rounded-xl border border-[var(--color-border)] bg-white px-3 py-2.5 text-sm outline-none focus:border-[var(--color-primary)]"
                      />
                    </div>
                  </div>
                  <p className="mt-2 text-[10px] leading-4 text-[var(--color-text-muted)]">
                    Due follow-ups wait until quiet hours end. If multiple steps become overdue, only the next step resumes; later steps keep their configured spacing and still require an open reply window.
                  </p>
                </div>
              )}
            </div>
          </Card>

          <Card>
            <SectionHeading
              number="2"
              title="Follow-up 1"
              description={form.messageMode === "ai"
                ? "AI writes from the recent conversation. Configure the fallback, media and service targeting together here."
                : "Configure the default message, languages, media and optional service-specific version in one place."}
            />
            {hasPromotionFollowUps && (
              <div className="mt-4 rounded-xl border border-[var(--color-primary)]/20 bg-[var(--color-primary-light)]/45 px-3.5 py-3">
                <p className="text-xs font-semibold text-[var(--color-primary)]">Promotion override is available</p>
                <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
                  For an eligible recent price/package enquiry, a configured promotion follow-up can replace Follow-up 1. If no safe promotion match is found, this normal Follow-up 1 is used.
                </p>
              </div>
            )}

            <FollowUpMessageMode
              mode={form.messageMode}
              instruction={form.aiInstruction}
              onChange={(patch) => setForm((current) => ({ ...current, ...patch }))}
            />

            <div className="mt-6 flex items-center justify-between gap-3">
              <label htmlFor="follow-up-message" className="text-sm font-semibold">
                {form.messageMode === "ai" ? "Fallback message" : "Default message"}
              </label>
              <span className="text-xs text-[var(--color-text-muted)]">{form.message.length}/1000</span>
            </div>
            <textarea
              id="follow-up-message"
              rows="4"
              maxLength="1000"
              value={form.message}
              onChange={(event) => onSourceMessageChange(event.target.value)}
              className="mt-2 w-full resize-y rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3.5 py-3 text-sm leading-6 outline-none focus:border-[var(--color-primary)] focus:ring-2 focus:ring-[var(--color-primary-light)]"
            />

            <div className="mt-5 border-t border-[var(--color-border)] pt-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold">Customer languages</p>
                    <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold text-[var(--color-text-muted)]">English · BM · 中文</span>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
                    {translationsNeedRefresh
                      ? "Language versions will refresh automatically when you save. Manual edits made after the latest message change are kept."
                      : `${translationReadyCount} language versions are ready and matched to the customer automatically.`}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setReviewTranslations((current) => !current)}
                  className="shrink-0 text-xs font-semibold text-[var(--color-primary)] hover:underline"
                >
                  {reviewTranslations ? "Hide translations" : "Review translations"}
                </button>
              </div>

              {reviewTranslations && (
                <div className="mt-4 border-t border-[var(--color-border)] pt-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-xs text-[var(--color-text-muted)]">Review or fine-tune any language. Manual edits are preserved when Save refreshes the other versions.</p>
                    <button
                      type="button"
                      onClick={onGenerateTranslations}
                      disabled={translating || !form.message.trim()}
                      className="inline-flex items-center justify-center gap-2 rounded-xl border border-[var(--color-primary)]/25 bg-white px-3.5 py-2 text-xs font-semibold text-[var(--color-primary)] disabled:opacity-50"
                    >
                      {translating && <Spinner className="h-3.5 w-3.5" />}
                      {translating ? "Generating…" : translationsNeedRefresh ? "Generate now" : "Regenerate"}
                    </button>
                  </div>

                  <div className="mt-4 flex gap-1 ui-scroll-x overflow-x-auto border-b border-[var(--color-border)]" role="tablist" aria-label="Follow-up language">
                    {FOLLOW_UP_LANGUAGES.map((language) => (
                      <button
                        key={language.key}
                        type="button"
                        role="tab"
                        aria-selected={translationLanguage === language.key}
                        onClick={() => setTranslationLanguage(language.key)}
                        className={`shrink-0 border-b-2 px-3 py-2 text-xs font-semibold ${translationLanguage === language.key ? "border-[var(--color-primary)] text-[var(--color-primary)]" : "border-transparent text-[var(--color-text-muted)]"}`}
                      >
                        {language.label}
                      </button>
                    ))}
                  </div>
                  <div className="mt-4 flex items-center justify-between gap-3">
                    <label htmlFor={`follow-up-${translationLanguage}`} className="text-xs font-semibold">{activeLanguage?.label} message</label>
                    <span className="text-[10px] text-[var(--color-text-muted)]">{form.translations[translationLanguage]?.length || 0}/1000</span>
                  </div>
                  <textarea
                    id={`follow-up-${translationLanguage}`}
                    rows="4"
                    maxLength="1000"
                    value={form.translations[translationLanguage] || ""}
                    onChange={(event) => onTranslationChange(translationLanguage, event.target.value)}
                    className="mt-2 w-full resize-y rounded-xl border border-[var(--color-border)] bg-white px-3.5 py-3 text-sm leading-6 outline-none focus:border-[var(--color-primary)] focus:ring-2 focus:ring-[var(--color-primary-light)]"
                  />
                </div>
              )}
            </div>

            <FollowUpMediaPicker
              imageUrl={form.imageUrl}
              videoKey={form.videoKey}
              videoFilename={form.videoFilename}
              uploadingImage={uploadingImage}
              uploadingVideo={uploadingVideo}
              onUploadImage={onUploadImage}
              onUploadVideo={onUploadVideo}
              onChange={(media) =>
                setForm((current) => ({ ...current, ...media }))
              }
              label="Follow-up 1 media"
              description="Optional. Attach one image or one video to Follow-up 1."
            />

            <ServiceOverridesEditor
              overrides={form.serviceOverrides}
              services={services}
              stepLabel="Follow-up 1"
              translating={translating}
              uploadingImage={uploadingImage}
              uploadingVideo={uploadingVideo}
              onUploadImage={onUploadImage}
              onUploadVideo={onUploadVideo}
              onTranslateMessage={onTranslateMessage}
              onChange={(serviceOverrides) =>
                setForm((current) => ({ ...current, serviceOverrides }))
              }
            />
          </Card>

          <Card>
            <SectionHeading
              number="3"
              title="More follow-ups"
              description="Add up to two more messages. Keep them collapsed when you are not editing them."
            />

            {form.additionalSteps.length > 0 ? (
              <div className="mt-5 space-y-3">
                {form.additionalSteps.map((step, index) => {
                  const expanded = expandedStepIndex === index;
                  return (
                    <div
                      key={index}
                      className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)]"
                    >
                      <div className="flex items-start gap-3 p-4">
                        <button
                          type="button"
                          className="min-w-0 flex-1 text-left"
                          onClick={() => {
                            setExpandedStepIndex(expanded ? null : index);
                            setPreviewStepIndex(index + 1);
                            setPreviewServiceName("");
                          }}
                          aria-expanded={expanded}
                        >
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                            <p className="text-sm font-bold">Follow-up {index + 2}</p>
                            <span className="text-xs text-[var(--color-text-muted)]">
                              {followUpTimingSummary(step)}
                            </span>
                          </div>
                          <StepSummaryChips step={step} />
                        </button>
                        <div className="flex shrink-0 items-center gap-3">
                          <button
                            type="button"
                            onClick={() => removeAdditionalStep(index)}
                            className="text-xs font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"
                          >
                            Remove
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setExpandedStepIndex(expanded ? null : index);
                              setPreviewStepIndex(index + 1);
                              setPreviewServiceName("");
                            }}
                            className="text-xs font-semibold text-[var(--color-primary)]"
                          >
                            {expanded ? "Close" : "Edit"}
                          </button>
                        </div>
                      </div>

                      {expanded && (
                        <div className="border-t border-[var(--color-border)] bg-white p-4 sm:p-5">
                          <FollowUpMessageMode
                            mode={step.messageMode}
                            instruction={step.aiInstruction}
                            onChange={(patch) => updateAdditionalStep(index, patch)}
                          />

                          <div className="mt-4 grid gap-4 sm:grid-cols-[12rem_minmax(0,1fr)]">
                            <FollowUpTimingFields
                              step={step}
                              compact
                              label="Send timing"
                              onChange={(patch) =>
                                updateAdditionalStep(index, patch)
                              }
                            />
                            <div>
                              <div className="flex items-center justify-between gap-3">
                                <label className="text-xs font-semibold">
                                  {step.messageMode === "ai" ? "Fallback message" : "Default message"}
                                </label>
                                <span className="text-[10px] text-[var(--color-text-muted)]">{step.message.length}/1000</span>
                              </div>
                              <textarea
                                rows="3"
                                maxLength="1000"
                                value={step.message}
                                onChange={(event) =>
                                  updateAdditionalStep(index, {
                                    message: event.target.value,
                                    translations: { en: "", ms: "", zh: "" },
                                  })
                                }
                                placeholder="Write the next follow-up message."
                                className="mt-1.5 w-full resize-y rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3.5 py-3 text-sm leading-6 outline-none focus:border-[var(--color-primary)]"
                              />
                              <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">
                                {step.messageMode === "ai"
                                  ? "Used only if AI generation is unavailable or invalid. Language versions are prepared automatically."
                                  : "Language versions are generated automatically when you save."}
                              </p>
                              <TranslationDetails
                                sourceMessage={step.message}
                                translations={step.translations}
                                translating={translating}
                                onTranslate={onTranslateMessage}
                                onReplace={(translations) =>
                                  updateAdditionalStep(index, { translations })
                                }
                                onChange={(languageKey, value) =>
                                  updateAdditionalStep(index, {
                                    translations: {
                                      ...step.translations,
                                      [languageKey]: value,
                                    },
                                  })
                                }
                              />
                            </div>
                          </div>

                          <FollowUpMediaPicker
                            imageUrl={step.imageUrl}
                            videoKey={step.videoKey}
                            videoFilename={step.videoFilename}
                            uploadingImage={uploadingImage}
                            uploadingVideo={uploadingVideo}
                            onUploadImage={onUploadImage}
                            onUploadVideo={onUploadVideo}
                            onChange={(media) =>
                              updateAdditionalStep(index, media)
                            }
                            label={`Follow-up ${index + 2} media`}
                          />

                          <ServiceOverridesEditor
                            overrides={step.serviceOverrides}
                            services={services}
                            stepLabel={`Follow-up ${index + 2}`}
                            translating={translating}
                            uploadingImage={uploadingImage}
                            uploadingVideo={uploadingVideo}
                            onUploadImage={onUploadImage}
                            onUploadVideo={onUploadVideo}
                            onTranslateMessage={onTranslateMessage}
                            onChange={(serviceOverrides) =>
                              updateAdditionalStep(index, { serviceOverrides })
                            }
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="mt-5 rounded-2xl border border-dashed border-[var(--color-border)] bg-[var(--color-bg)] px-5 py-6 text-center">
                <p className="text-sm font-semibold">Only Follow-up 1 is active</p>
                <p className="mt-1 text-xs text-[var(--color-text-muted)]">Add another step if you want to re-engage customers who stay silent.</p>
              </div>
            )}

            <button
              type="button"
              disabled={form.additionalSteps.length >= 2 || suggestedNextDelay === null}
              onClick={() => {
                if (suggestedNextDelay === null) return;
                const nextIndex = form.additionalSteps.length;
                setForm((current) => ({
                  ...current,
                  additionalSteps: [
                    ...current.additionalSteps,
                    {
                      delayMinutes: suggestedNextDelay,
                      timingMode: "after_reply",
                      beforeWindowExpiryMinutes: 120,
                      messageMode: "fixed",
                      aiInstruction: "",
                      message: "",
                      translations: { en: "", ms: "", zh: "" },
                      imageUrl: "",
                      videoKey: "",
                      videoFilename: "",
                      serviceOverrides: [],
                    },
                  ],
                }));
                setExpandedStepIndex(nextIndex);
                setPreviewStepIndex(nextIndex + 1);
                setPreviewServiceName("");
              }}
              className="mt-4 rounded-xl border border-[var(--color-primary)]/25 bg-white px-4 py-2.5 text-xs font-semibold text-[var(--color-primary)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              + Add follow-up
            </button>
          </Card>
        </div>

        <aside className="order-1 xl:order-2 xl:sticky xl:top-6 xl:self-start">
          <button
            type="button"
            aria-label="Toggle follow-up preview"
            aria-expanded={mobilePreviewOpen}
            onClick={() => setMobilePreviewOpen((current) => !current)}
            className="flex w-full items-center justify-between gap-3 rounded-2xl border border-[var(--color-border)] bg-white px-4 py-3.5 text-left shadow-sm xl:hidden"
          >
            <div className="min-w-0">
              <p className="text-sm font-bold">Preview message</p>
              <p className="mt-0.5 truncate text-[10px] text-[var(--color-text-muted)]">
                Follow-up {safePreviewIndex + 1} · {followUpTimingSummary(previewStep)}
              </p>
            </div>
            <span className="shrink-0 text-xs font-semibold text-[var(--color-primary)]">
              {mobilePreviewOpen ? "Hide" : "Open"}
            </span>
          </button>

          <div className={`${mobilePreviewOpen ? "mt-3 block" : "hidden"} xl:mt-0 xl:block`}>
            <Card>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">Preview</p>
                  <h2 className="mt-1 font-display text-sm font-bold">Follow-up {safePreviewIndex + 1}</h2>
                </div>
                <div className="flex rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-1">
                  {allSteps.map((_, index) => (
                    <button
                      key={index}
                      type="button"
                      aria-label={`Preview Follow-up ${index + 1}`}
                      onClick={() => {
                        setPreviewStepIndex(index);
                        setPreviewServiceName("");
                      }}
                      className={`min-w-8 rounded-md px-2 py-1 text-[10px] font-bold ${safePreviewIndex === index ? "bg-white text-[var(--color-primary)] shadow-sm" : "text-[var(--color-text-muted)]"}`}
                    >
                      {index + 1}
                    </button>
                  ))}
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[10px] text-[var(--color-text-muted)]">
                <span className="font-semibold">{followUpTimingSummary(previewStep)}</span>
                {previewStep?.messageMode === "ai" && (
                  <span className="rounded-full bg-[var(--color-bg)] px-2 py-1 font-semibold">AI</span>
                )}
                {previewMediaSource?.videoKey && (
                  <span className="rounded-full bg-[var(--color-bg)] px-2 py-1 font-semibold">Video</span>
                )}
                {!previewMediaSource?.videoKey && previewMediaSource?.imageUrl && (
                  <span className="rounded-full bg-[var(--color-bg)] px-2 py-1 font-semibold">Image</span>
                )}
                {(previewStep?.serviceOverrides || []).length > 0 && (
                  <span className="rounded-full bg-[var(--color-bg)] px-2 py-1 font-semibold">
                    {previewStep.serviceOverrides.length} service{previewStep.serviceOverrides.length === 1 ? "" : "s"}
                  </span>
                )}
              </div>

              <div className="mt-3 flex gap-1 overflow-x-auto border-b border-[var(--color-border)]" role="tablist" aria-label="Preview language">
                {FOLLOW_UP_LANGUAGES.map((language) => (
                  <button
                    key={language.key}
                    type="button"
                    role="tab"
                    aria-selected={translationLanguage === language.key}
                    onClick={() => setTranslationLanguage(language.key)}
                    className={`shrink-0 border-b-2 px-2 py-1.5 text-[10px] font-semibold ${translationLanguage === language.key ? "border-[var(--color-primary)] text-[var(--color-primary)]" : "border-transparent text-[var(--color-text-muted)]"}`}
                  >
                    {language.label}
                  </button>
                ))}
              </div>

              {(previewStep?.serviceOverrides || []).length > 0 && (
                <div className="mt-3">
                  <label className="text-[10px] font-semibold text-[var(--color-text-muted)]">Preview version</label>
                  <select
                    value={previewServiceName}
                    onChange={(event) => setPreviewServiceName(event.target.value)}
                    className="mt-1.5 w-full rounded-xl border border-[var(--color-border)] bg-white px-3 py-2 text-xs outline-none focus:border-[var(--color-primary)]"
                  >
                    <option value="">Default</option>
                    {(previewStep.serviceOverrides || []).map((item) => (
                      <option key={item.serviceName} value={item.serviceName}>
                        {item.serviceName}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {previewStep?.messageMode === "ai" && (
                <p className="mt-3 text-[10px] leading-4 text-[var(--color-text-muted)]">
                  AI writes the live message from the conversation. This preview shows the configured fallback.
                </p>
              )}

              <div className="inbox-thread-bg mt-4 min-h-48 rounded-2xl border border-[var(--color-border)] p-4">
                <div className="ml-auto max-w-[94%] overflow-hidden rounded-2xl rounded-br-md bg-[var(--color-primary)] text-white shadow-sm">
                  {previewMediaSource?.imageUrl && (
                    <img src={previewMediaSource.imageUrl} alt="" className="max-h-56 w-full object-cover" />
                  )}
                  {previewMediaSource?.videoKey && (
                    <video
                      key={previewVideoUrl}
                      src={previewVideoUrl}
                      controls
                      preload="none"
                      playsInline
                      className="max-h-56 w-full bg-black object-contain"
                    />
                  )}
                  <div className="px-3.5 py-2.5">
                    <p className="mb-1 text-[10px] font-semibold text-white/70">
                      {previewServiceName ? `Automated follow-up · ${previewServiceName}` : "Automated follow-up"}
                    </p>
                    <p className="whitespace-pre-wrap break-words text-xs leading-5">{previewMessage}</p>
                  </div>
                </div>
              </div>

              <details className="group mt-4 border-t border-[var(--color-border)] pt-3">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-xs font-semibold">
                  <span>Sending rules</span>
                  <span className="text-[var(--color-primary)]">
                    <span className="group-open:hidden">View</span>
                    <span className="hidden group-open:inline">Hide</span>
                  </span>
                </summary>
                <ul className="mt-3 space-y-3">
                  <Rule text="Any customer reply stops all remaining follow-ups in that sequence." />
                  <Rule text="WhatsApp, Messenger, and Instagram follow-ups only send while the permitted reply window is open." />
                  <Rule text="A failed or unconfirmed follow-up blocks later steps for staff review." />
                  <Rule text="If AI decides to skip or request human review, the remaining steps for that conversation cycle stop too." />
                  <Rule text="A real staff takeover cancels an older AI-started sequence. A later staff reply can start a fresh sequence." />
                  <Rule text="A newer normal AI or staff reply starts a fresh sequence from that message. Sent scheduled staff messages count as staff replies." />
                  <Rule text="A targeted message is used only when the lead interest clearly matches one configured service; otherwise the default message is used." />
                  <Rule text="WhatsApp opt-outs remain a hard stop." />
                  <Rule text="Saving does not add follow-ups to older conversations." />
                </ul>
              </details>
            </Card>
          </div>
        </aside>
      </div>
    </ToolShell>
  );
}

function CommentAutomationTool({
  form,
  setForm,
  savedEnabled,
  hasUnsavedChanges,
  saving,
  channelStatus,
  isAdmin,
  statusLoading,
  statusError,
  onRefreshStatus,
  onSave,
  toasts,
  dismissToast,
}) {
  const noChannelSelected =
    form.enabled && !form.facebookEnabled && !form.instagramEnabled;
  const noReplyActionSelected =
    form.enabled && !form.publicReplyEnabled && !form.privateReplyEnabled;
  const fixedReplyInvalid =
    form.enabled &&
    form.publicReplyEnabled &&
    form.publicReplyStyle === "fixed" &&
    !form.fixedPublicReply.trim();
  const hasInvalidState =
    noChannelSelected || noReplyActionSelected || fixedReplyInvalid;
  const replyMode =
    form.publicReplyEnabled && form.privateReplyEnabled
      ? "both"
      : form.privateReplyEnabled
        ? "private"
        : form.publicReplyEnabled
          ? "public"
          : "none";
  const selectedChannelCount =
    Number(form.facebookEnabled) + Number(form.instagramEnabled);
  const selectedStatuses = [
    form.facebookEnabled ? channelStatus?.facebook : null,
    form.instagramEnabled ? channelStatus?.instagram : null,
  ].filter(Boolean);
  const selectedChannelNeedsSetup = selectedStatuses.some(
    (status) => status?.state && status.state !== "ready"
  );
  const selectedChannelsLookReady =
    selectedChannelCount > 0 &&
    selectedStatuses.length === selectedChannelCount &&
    selectedStatuses.every((status) => status?.state === "ready");
  const saveLabel =
    form.enabled !== savedEnabled
      ? form.enabled
        ? "Save & turn on"
        : "Save & pause"
      : "Save changes";

  function setReplyMode(mode) {
    if (mode === "both") {
      setForm((current) => ({
        ...current,
        publicReplyEnabled: true,
        privateReplyEnabled: true,
      }));
      return;
    }
    if (mode === "private") {
      setForm((current) => ({
        ...current,
        publicReplyEnabled: false,
        privateReplyEnabled: true,
      }));
      return;
    }
    setForm((current) => ({
      ...current,
      publicReplyEnabled: true,
      privateReplyEnabled: false,
    }));
  }

  return (
    <ToolShell
      title="Comment automation"
      description="Automatically reply to Facebook and Instagram comments and turn interested commenters into leads."
      enabled={form.enabled}
      savedEnabled={savedEnabled}
      hasUnsavedChanges={hasUnsavedChanges}
      onToggle={() => setForm((current) => ({ ...current, enabled: !current.enabled }))}
      saveLabel={saveLabel}
      saving={saving}
      saveDisabled={saving || !hasUnsavedChanges || hasInvalidState}
      onSave={onSave}
      toasts={toasts}
      dismissToast={dismissToast}
    >
      <div className="grid gap-5 min-[1800px]:grid-cols-[minmax(0,1.28fr)_minmax(19rem,0.72fr)]">
        <div className="space-y-5">
          <Card>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <SectionHeading
                number="1"
                title="Where should this work?"
                description="Choose the social accounts where you want new comments handled automatically."
              />
              <button
                type="button"
                onClick={onRefreshStatus}
                disabled={statusLoading}
                className="inline-flex min-h-10 shrink-0 items-center justify-center gap-2 self-start rounded-xl border border-[var(--color-border)] bg-white px-3.5 text-xs font-semibold text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {statusLoading && <Spinner className="h-3.5 w-3.5" />}
                {statusLoading ? "Checking…" : "Check connection"}
              </button>
            </div>

            <div className="mt-5 grid gap-3 md:grid-cols-2">
              <CommentChannelCard
                label="Facebook"
                description="Reply to comments on your connected Facebook Page posts."
                status={channelStatus?.facebook || null}
                statusLoading={statusLoading && !channelStatus}
                checked={form.facebookEnabled}
                onChange={() =>
                  setForm((current) => ({ ...current, facebookEnabled: !current.facebookEnabled }))
                }
              />
              <CommentChannelCard
                label="Instagram"
                description="Reply to comments on your connected Instagram posts."
                status={channelStatus?.instagram || null}
                statusLoading={statusLoading && !channelStatus}
                checked={form.instagramEnabled}
                onChange={() =>
                  setForm((current) => ({ ...current, instagramEnabled: !current.instagramEnabled }))
                }
              />
            </div>

            {statusError ? (
              <div className="mt-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3.5 py-3">
                <p className="text-xs font-semibold">We couldn't check the connections right now.</p>
                <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
                  You can keep editing. Try Check connection again before turning the automation on.
                </p>
              </div>
            ) : selectedChannelNeedsSetup ? (
              <div className="mt-4 flex flex-col gap-2 rounded-xl border border-[var(--color-accent)]/30 bg-[var(--color-accent-light)] px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-xs font-semibold text-[var(--color-text)]">One or more selected channels still need setup.</p>
                  <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
                    {isAdmin
                      ? "Finish the connection first, then come back and run one live comment test."
                      : "Ask an admin to finish the connection first, then come back and run one live comment test."}
                  </p>
                </div>
                {isAdmin && (
                  <Link
                    to="/settings/setup"
                    onClick={(event) => {
                      if (
                        hasUnsavedChanges &&
                        !window.confirm("You have unsaved Comment automation changes. Open connection setup without saving them?")
                      ) {
                        event.preventDefault();
                      }
                    }}
                    className="inline-flex min-h-10 shrink-0 items-center justify-center rounded-xl border border-[var(--color-accent)]/30 bg-white px-3 text-xs font-semibold text-[var(--color-accent-text)] transition hover:bg-white/70"
                  >
                    Fix connection
                  </Link>
                )}
              </div>
            ) : selectedChannelsLookReady ? (
              <div className="mt-4 rounded-xl border border-[var(--color-primary)]/20 bg-[var(--color-primary-light)]/55 px-3.5 py-3">
                <p className="text-xs font-semibold text-[var(--color-primary)]">Connections look ready.</p>
                <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
                  After you turn this on, leave one new test comment to confirm the public reply and private message work as expected.
                </p>
              </div>
            ) : (
              <p className="mt-4 text-xs leading-5 text-[var(--color-text-muted)]">
                Check the connection before going live. A real test comment is the final check that comment replies are working.
              </p>
            )}

            {noChannelSelected && (
              <InlineWarning>
                Choose Facebook, Instagram, or both before turning this automation on.
              </InlineWarning>
            )}
          </Card>

          <Card>
            <SectionHeading
              number="2"
              title="What should happen when someone comments?"
              description="Pick the experience you want customers to receive. You can change it later."
            />

            <div className="mt-5 grid gap-3" role="radiogroup" aria-label="What should happen when someone comments?">
              <CommentActionChoice
                checked={replyMode === "both"}
                recommended
                title="Reply publicly + send a private message"
                description="Acknowledge the customer under the post, then continue the enquiry privately and add the lead to Inbox / Pipeline."
                onClick={() => setReplyMode("both")}
              />
              <CommentActionChoice
                checked={replyMode === "private"}
                title="Send a private message only"
                description="Move the enquiry straight to DM without posting a public reply under the comment."
                onClick={() => setReplyMode("private")}
              />
              <CommentActionChoice
                checked={replyMode === "public"}
                title="Reply publicly only"
                description="Reply under the post without starting a private conversation or creating a lead from the private reply."
                onClick={() => setReplyMode("public")}
              />
            </div>

            {noReplyActionSelected && (
              <InlineWarning>
                Choose what should happen before turning this automation on.
              </InlineWarning>
            )}

            {form.publicReplyEnabled && (
              <div className="mt-6 border-t border-[var(--color-border)] pt-5">
                <p className="text-sm font-semibold">How should the public reply be written?</p>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <button
                    type="button"
                    aria-pressed={form.publicReplyStyle === "ai"}
                    onClick={() => setForm((current) => ({ ...current, publicReplyStyle: "ai" }))}
                    className={`rounded-xl border p-4 text-left transition-colors ${
                      form.publicReplyStyle === "ai"
                        ? "border-[var(--color-primary)] bg-[var(--color-primary-light)]/55"
                        : "border-[var(--color-border)] hover:bg-[var(--color-bg)]"
                    }`}
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold">Let AI write it</span>
                      <span className="rounded-full bg-[var(--color-primary-light)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-primary)]">Recommended</span>
                    </span>
                    <span className="mt-1.5 block text-xs leading-5 text-[var(--color-text-muted)]">
                      Match the customer's language and the post context while keeping the reply short.
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-pressed={form.publicReplyStyle === "fixed"}
                    onClick={() => setForm((current) => ({ ...current, publicReplyStyle: "fixed" }))}
                    className={`rounded-xl border p-4 text-left transition-colors ${
                      form.publicReplyStyle === "fixed"
                        ? "border-[var(--color-primary)] bg-[var(--color-primary-light)]/55"
                        : "border-[var(--color-border)] hover:bg-[var(--color-bg)]"
                    }`}
                  >
                    <span className="block text-sm font-semibold">Always use the same reply</span>
                    <span className="mt-1.5 block text-xs leading-5 text-[var(--color-text-muted)]">
                      Best when you want every eligible comment to receive identical wording.
                    </span>
                  </button>
                </div>

                {form.publicReplyStyle === "fixed" && (
                  <div className="mt-4">
                    <div className="flex items-center justify-between gap-3">
                      <label htmlFor="comment-fixed-reply" className="text-xs font-semibold">
                        Public reply
                      </label>
                      <span className="text-[10px] text-[var(--color-text-muted)]">
                        {form.fixedPublicReply.length}/300
                      </span>
                    </div>
                    <textarea
                      id="comment-fixed-reply"
                      rows="3"
                      maxLength="300"
                      value={form.fixedPublicReply}
                      onChange={(event) =>
                        setForm((current) => ({ ...current, fixedPublicReply: event.target.value }))
                      }
                      className="mt-2 w-full resize-y rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3.5 py-3 text-base leading-6 outline-none focus:border-[var(--color-primary)] focus:ring-2 focus:ring-[var(--color-primary-light)] sm:text-sm"
                    />
                    {fixedReplyInvalid && (
                      <p className="mt-2 text-xs font-medium text-[var(--color-danger)]">
                        Add the public reply text before saving.
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </Card>

          <details className="group rounded-xl border border-[var(--color-border)] bg-white">
            <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 rounded-xl px-5 py-4 font-display text-sm font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-primary)]/30 sm:px-6 [&::-webkit-details-marker]:hidden">
              <span>
                Advanced settings
                <span className="mt-1 block font-sans text-xs font-normal leading-5 text-[var(--color-text-muted)]">
                  The recommended defaults work well for most businesses.
                </span>
              </span>
              <ChevronDownIcon className="h-4 w-4 shrink-0 text-[var(--color-text-muted)] transition-transform group-open:rotate-180" />
            </summary>
            <div className="border-t border-[var(--color-border)] px-5 py-5 sm:px-6">
              <div className="space-y-3">
                <ToggleSetting
                  label="Ignore comments containing only emojis"
                  description="Skip comments such as 👍 or 🔥🔥 when there are no words or numbers."
                  checked={form.skipEmojiOnly}
                  onChange={() =>
                    setForm((current) => ({ ...current, skipEmojiOnly: !current.skipEmojiOnly }))
                  }
                />
                <ToggleSetting
                  label="Only respond to the original comment"
                  description="Do not let the automation join conversations happening underneath a comment."
                  checked={form.skipNestedReplies}
                  onChange={() =>
                    setForm((current) => ({ ...current, skipNestedReplies: !current.skipNestedReplies }))
                  }
                />
              </div>
            </div>
          </details>
        </div>

        <aside className="space-y-5 min-[1800px]:sticky min-[1800px]:top-6 min-[1800px]:self-start">
          <CommentFlowPreview form={form} />

          <Card>
            <h2 className="font-display text-sm font-bold">{form.enabled || savedEnabled ? "Test your automation" : "Before you turn it on"}</h2>
            <div className="mt-4 rounded-xl border border-[var(--color-primary)]/20 bg-[var(--color-primary-light)]/45 p-3.5">
              <p className="text-xs font-semibold text-[var(--color-primary)]">Run one real comment test</p>
              <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
                Leave a new comment on a recent Facebook or Instagram post. Confirm the reply appears and, if enabled, the private message arrives.
              </p>
            </div>
            <h3 className="mt-5 text-xs font-semibold">Good to know</h3>
            <ul className="mt-3 space-y-3">
              <Rule text="Only new comments received after the automation is turned on are handled." />
              <Rule text="The same comment will not be replied to twice if the platform sends it more than once." />
              <Rule text="If AI replies are paused for the whole account, this automation pauses too." />
              <Rule text="A comment alone does not let the bot keep messaging privately. The customer must reply to the private message first." />
              <Rule text="Complaints, safety issues, and requests for a human can still be flagged for staff." />
            </ul>
          </Card>
        </aside>
      </div>
    </ToolShell>
  );
}

function CommentChannelCard({
  label,
  description,
  status,
  statusLoading,
  checked,
  onChange,
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={`Use ${label} for comment automation`}
      onClick={onChange}
      className={`flex w-full items-start justify-between gap-4 rounded-xl border p-4 text-left transition-colors ${
        checked
          ? "border-[var(--color-primary)]/35 bg-[var(--color-primary-light)]/35"
          : "border-[var(--color-border)] bg-[var(--color-bg)] hover:bg-white"
      }`}
    >
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">{label}</span>
          {(status || statusLoading) && (
            <span className="inline-flex items-center gap-1.5">
              <span className="text-[10px] font-medium text-[var(--color-text-muted)]">Connection</span>
              <ChannelReadinessBadge status={status} loading={statusLoading} />
            </span>
          )}
        </span>
        <span className="mt-1.5 block text-xs leading-5 text-[var(--color-text-muted)]">{description}</span>
        <span className={`mt-2 block text-[10px] font-semibold ${checked ? "text-[var(--color-primary)]" : "text-[var(--color-text-muted)]"}`}>
          {checked ? "Included in automation" : "Not included"}
        </span>
      </span>
      <span
        aria-hidden="true"
        className={`relative mt-0.5 h-8 w-14 shrink-0 rounded-full transition-colors ${checked ? "bg-[var(--color-primary)]" : "bg-[var(--color-border)]"}`}
      >
        <span className={`absolute left-0 top-1 h-6 w-6 rounded-full bg-white shadow-sm transition-transform ${checked ? "translate-x-7" : "translate-x-1"}`} />
      </span>
    </button>
  );
}

function CommentActionChoice({ checked, recommended = false, title, description, onClick }) {
  return (
    <label
      className={`flex w-full cursor-pointer items-start gap-3 rounded-xl border p-4 text-left transition-colors focus-within:ring-2 focus-within:ring-[var(--color-primary)]/25 ${
        checked
          ? "border-[var(--color-primary)] bg-[var(--color-primary-light)]/45"
          : "border-[var(--color-border)] bg-white hover:bg-[var(--color-bg)]"
      }`}
    >
      <input
        type="radio"
        name="comment-action-mode"
        checked={checked}
        onChange={onClick}
        className="sr-only"
      />
      <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${checked ? "border-[var(--color-primary)]" : "border-[var(--color-border)]"}`} aria-hidden="true">
        {checked && <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-primary)]" />}
      </span>
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">{title}</span>
          {recommended && (
            <span className="rounded-full bg-[var(--color-primary-light)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-primary)]">Recommended</span>
          )}
        </span>
        <span className="mt-1 block text-xs leading-5 text-[var(--color-text-muted)]">{description}</span>
      </span>
    </label>
  );
}

function CommentFlowPreview({ form }) {
  return (
    <Card>
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">
        Customer experience preview
      </p>
      <div className="mt-4 space-y-2.5">
        <CommentPreviewStep label="Customer comment" tone="neutral">
          How much is this?
        </CommentPreviewStep>
        {form.publicReplyEnabled && (
          <>
            <FlowArrow />
            <CommentPreviewStep label="Public reply" tone="primary">
              {form.publicReplyStyle === "fixed"
                ? form.fixedPublicReply || "Your fixed reply will appear here."
                : form.privateReplyEnabled
                  ? "Thanks for asking 😊 I’ll send you the details in a private message."
                  : "Thanks for asking 😊 Send us a DM and we’ll help you there."}
            </CommentPreviewStep>
          </>
        )}
        {form.privateReplyEnabled && (
          <>
            <FlowArrow />
            <CommentPreviewStep label="Private message" tone="surface">
              AI answers using the post and comment context, then continues the conversation privately.
            </CommentPreviewStep>
            <FlowArrow />
            <CommentPreviewStep label="Lead created" tone="success">
              The customer appears in Inbox and Pipeline after the private message is successfully sent.
            </CommentPreviewStep>
          </>
        )}
      </div>
    </Card>
  );
}

function CommentPreviewStep({ label, tone, children }) {
  const classes =
    tone === "primary"
      ? "border-[var(--color-primary)]/20 bg-[var(--color-primary-light)]/45"
      : tone === "success"
        ? "border-[var(--color-primary)]/20 bg-white"
        : tone === "surface"
          ? "border-[var(--color-border)] bg-white shadow-sm"
          : "border-[var(--color-border)] bg-[var(--color-bg)]";

  return (
    <div className={`rounded-xl border p-3.5 ${classes}`}>
      <p className={`text-[11px] font-semibold ${tone === "primary" || tone === "success" ? "text-[var(--color-primary)]" : "text-[var(--color-text-muted)]"}`}>{label}</p>
      <p className="mt-1 text-xs leading-5">{children}</p>
    </div>
  );
}

function FlowArrow() {
  return (
    <div className="flex justify-center" aria-hidden="true">
      <svg viewBox="0 0 24 24" className="h-4 w-4 text-[var(--color-text-muted)]" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 4v15m0 0-5-5m5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

function LeadScoringTool({ form, setForm, savedEnabled, hasUnsavedChanges, saving, onSave, toasts, dismissToast }) {
  return (
    <ToolShell
      title="Lead temperature"
      description="Let AI update Hot / Warm / Cold when customer intent is clear. Staff-controlled temperatures always win."
      enabled={form.enabled}
      savedEnabled={savedEnabled}
      hasUnsavedChanges={hasUnsavedChanges}
      onToggle={() => setForm((current) => ({ ...current, enabled: !current.enabled }))}
      saveLabel="Save changes"
      saving={saving}
      saveDisabled={saving || !hasUnsavedChanges}
      onSave={onSave}
      toasts={toasts}
      dismissToast={dismissToast}
    >
      <div className="space-y-5">
        <Card>
          <SectionHeading title="How it works" description="The AI only changes lead temperature when there is a clear sales signal." />
          <div className="mt-5 grid gap-3 md:grid-cols-3">
            <OutcomeCard icon={<HotIcon className="h-4 w-4" />} iconClass="bg-red-50 text-red-600" title="Booking intent → Hot" text="Clear intent to book, schedule, pay or proceed can move a lead to Hot." />
            <OutcomeCard icon={<ColdIcon className="h-4 w-4" />} iconClass="bg-blue-50 text-blue-600" title="Clear rejection → Cold" text="A clear no, rejection or loss of interest can move a lead to Cold." />
            <OutcomeCard icon={<StaffIcon className="h-4 w-4" />} iconClass="bg-[var(--color-primary-light)] text-[var(--color-primary)]" title="Staff changes always win" text="A temperature set manually by staff is never overwritten automatically." />
          </div>
          <p className="mt-4 text-xs leading-5 text-[var(--color-text-muted)]">AI conversation summaries can still run independently when automatic temperature is paused.</p>
        </Card>

        <details className="rounded-xl border border-[var(--color-border)] bg-white p-5 sm:p-6">
          <summary className="cursor-pointer select-none font-display text-sm font-bold">Advanced timing settings</summary>
          <p className="mt-2 text-xs leading-5 text-[var(--color-text-muted)]">Most clinics can keep the defaults. Change these only if you want the AI to review conversations sooner or later.</p>
          <div className="mt-5 grid gap-4 md:grid-cols-3">
            <ScoringField id="scoring-inactivity" label="Conversation quiet for" hint="5 to 30 minutes" value={form.inactivityMinutes} min="5" max="30" suffix="minutes" onChange={(value) => setForm((current) => ({ ...current, inactivityMinutes: value }))} />
            <ScoringField id="scoring-duration" label="Maximum active time" hint="30 to 120 minutes" value={form.maxConversationMinutes} min="30" max="120" suffix="minutes" onChange={(value) => setForm((current) => ({ ...current, maxConversationMinutes: value }))} />
            <ScoringField id="scoring-messages" label="Maximum chat length" hint="20 to 80 messages" value={form.maxMessages} min="20" max="80" suffix="messages" onChange={(value) => setForm((current) => ({ ...current, maxMessages: value }))} />
          </div>
        </details>
      </div>
    </ToolShell>
  );
}

function ToolShell({ title, description, enabled, savedEnabled, hasUnsavedChanges, onToggle, saveLabel, saving, saveDisabled, onSave, children, toasts, dismissToast }) {
  const enabledStateChanged = enabled !== savedEnabled;
  const enabledLabel = enabledStateChanged
    ? enabled
      ? "On after save"
      : "Off after save"
    : enabled
      ? "On"
      : "Off";

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-bg)]">
      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6 sm:py-6 xl:px-10 xl:py-7">
        <div className="mx-auto max-w-6xl pb-10">
          <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="max-w-3xl">
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">{title}</h1>
              </div>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--color-text-muted)] sm:text-[15px]">{description}</p>
            </div>

            <div className="flex shrink-0 items-center justify-between gap-2 sm:justify-end">
              <span className="text-sm font-semibold text-[var(--color-text)]">{enabledLabel}</span>
              <Switch checked={enabled} onChange={onToggle} ariaLabel={`Enable ${title}`} />
            </div>
          </header>

          <div className="mt-5 sm:mt-6">{children}</div>
        </div>
      </main>

      {(hasUnsavedChanges || saving) && (
        <footer className="shrink-0 border-t border-[var(--color-border)] bg-white px-4 py-3 sm:px-6 xl:px-10">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className={`h-2 w-2 shrink-0 rounded-full ${saving ? "bg-[var(--color-primary)]" : "bg-[var(--color-accent)]"}`} />
              <p className="truncate text-[13px] font-medium text-[var(--color-text-muted)]">{saving ? "Saving changes…" : "You have unsaved changes"}</p>
            </div>
            <button type="button" onClick={onSave} disabled={saveDisabled} className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-[var(--color-primary)] px-4 py-2 text-xs font-semibold text-white hover:bg-[var(--color-primary-hover)] disabled:cursor-not-allowed disabled:opacity-50 sm:px-5 sm:py-2.5 sm:text-sm">
              {saving && <Spinner />}
              {saving ? "Saving…" : saveLabel}
            </button>
          </div>
        </footer>
      )}

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

function ToolsSidebar({ activeTool, onSelect, followUpActive, commentActive, scoringActive, distributionActive }) {
  return (
    <aside className="w-full min-w-0 max-w-full shrink-0 overflow-hidden border-b border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-2.5 sm:px-3.5 sm:py-3 xl:h-full xl:w-72 xl:border-b-0 xl:border-r xl:px-4 xl:py-5">
      <div className="px-1">
        <p className="font-display text-base font-bold sm:text-lg xl:text-[22px] xl:leading-7">Tools</p>
        <p className="mt-1 hidden text-[13px] leading-5 text-[var(--color-text-muted)] xl:block">
          Choose and manage the automations your team uses.
        </p>
      </div>

      <nav className="mt-2 grid min-w-0 max-w-full grid-cols-4 gap-1 sm:mt-3 sm:gap-1.5 xl:mt-4 xl:block xl:space-y-1" aria-label="Available tools">
        <ToolNavButton active={activeTool === "followUp"} onClick={() => onSelect("followUp")} icon={<ClockIcon className="h-[18px] w-[18px]" />} title="Automated follow-up" shortTitle="Follow-up" description="Remind leads who stop replying" enabled={followUpActive} />
        <ToolNavButton active={activeTool === "commentAutomation"} onClick={() => onSelect("commentAutomation")} icon={<CommentIcon className="h-[18px] w-[18px]" />} title="Comment automation" shortTitle="Comments" description="Reply to comments and open DMs" enabled={commentActive} />
        <ToolNavButton active={activeTool === "leadScoring"} onClick={() => onSelect("leadScoring")} icon={<ScoreIcon className="h-[18px] w-[18px]" />} title="Lead temperature" shortTitle="Temperature" description="Keep Hot, Warm and Cold updated" enabled={scoringActive} />
        <ToolNavButton active={activeTool === "leadDistribution"} onClick={() => onSelect("leadDistribution")} icon={<DistributionIcon className="h-[18px] w-[18px]" />} title="Lead distribution" shortTitle="Routing" description="Assign new leads to Sales staff" enabled={distributionActive} />
      </nav>
    </aside>
  );
}

function ToolNavButton({ active, onClick, icon, title, shortTitle, description, enabled }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={title}
      title={title}
      className={`flex min-h-16 w-full min-w-0 flex-col items-center justify-center gap-1.5 rounded-lg px-1 py-1.5 text-center transition-colors sm:min-h-[4.5rem] sm:gap-2 sm:rounded-xl sm:px-2 xl:min-h-0 xl:flex-row xl:justify-start xl:gap-3 xl:px-3 xl:py-3 xl:text-left ${active ? "bg-[var(--color-primary-light)] text-[var(--color-primary)]" : "text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)]"}`}
      aria-current={active ? "page" : undefined}
    >
      <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg sm:h-8 sm:w-8 xl:h-9 xl:w-9 ${active ? "bg-white text-[var(--color-primary)]" : "bg-[var(--color-bg)] text-[var(--color-text-muted)]"}`}>
        {icon}
      </span>
      <span className="min-w-0 xl:flex-1">
        <span className={`block text-[11px] font-semibold leading-3.5 sm:hidden ${active ? "text-[var(--color-primary)]" : "text-[var(--color-text)]"}`}>{shortTitle}</span>
        <span className={`hidden text-xs font-semibold leading-4 sm:block sm:text-[13px] xl:whitespace-nowrap xl:text-sm xl:font-bold xl:leading-5 ${active ? "text-[var(--color-primary)]" : "text-[var(--color-text)]"}`}>{title}</span>
        <span className="mt-0.5 hidden text-xs leading-4 text-[var(--color-text-muted)] xl:block">
          <span className={enabled ? "font-semibold text-[var(--color-primary)]" : "font-semibold text-[var(--color-text-muted)]"}>{enabled ? "On" : "Off"}</span>
          <span className="mx-1" aria-hidden="true">·</span>
          {description}
        </span>
      </span>
      <span className="sr-only">{enabled ? "Active" : "Paused"}</span>
    </button>
  );
}

function Card({ children }) {
  return <section className="rounded-xl border border-[var(--color-border)] bg-white p-4 sm:p-5">{children}</section>;
}

function SectionHeading({ number, title, description }) {
  return (
    <div className="flex items-start gap-3">
      {number && <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--color-primary-light)] text-xs font-bold text-[var(--color-primary)]">{number}</span>}
      <div>
        <h2 className="font-display text-base font-bold">{title}</h2>
        {description && <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)] sm:text-[13px]">{description}</p>}
      </div>
    </div>
  );
}

function Switch({ checked, onChange, ariaLabel, disabled = false }) {
  return (
    <button type="button" role="switch" aria-label={ariaLabel} aria-checked={checked} disabled={disabled} onClick={onChange} className={`relative h-7 w-12 shrink-0 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 disabled:cursor-not-allowed disabled:opacity-50 ${checked ? "bg-[var(--color-primary)]" : "bg-[var(--color-border)]"}`}>
      <span aria-hidden="true" className={`absolute left-0 top-1 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${checked ? "translate-x-6" : "translate-x-1"}`} />
    </button>
  );
}

function ToggleSetting({ label, description, status = null, statusLoading = false, checked, onChange }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className="flex w-full items-start justify-between gap-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4 text-left transition-colors hover:border-[var(--color-primary)]/30 hover:bg-white"
    >
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-2">
          <span className="block text-sm font-semibold">{label}</span>
          {(status || statusLoading) && (
            <ChannelReadinessBadge status={status} loading={statusLoading} />
          )}
        </span>
        <span className="mt-1 block text-xs leading-5 text-[var(--color-text-muted)]">{description}</span>
        {status?.detail && (
          <span className="mt-1.5 block text-xs leading-5 text-[var(--color-text-muted)]">
            {status.detail}
          </span>
        )}
      </span>
      <span
        aria-hidden="true"
        className={`relative mt-0.5 h-8 w-14 shrink-0 rounded-full transition-colors ${checked ? "bg-[var(--color-primary)]" : "bg-[var(--color-border)]"}`}
      >
        <span
          className={`absolute left-0 top-1 h-6 w-6 rounded-full bg-white shadow-sm transition-transform ${checked ? "translate-x-7" : "translate-x-1"}`}
        />
      </span>
    </button>
  );
}

function ChannelReadinessBadge({ status, loading = false }) {
  if (loading) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-white px-2 py-0.5 text-[10px] font-semibold text-[var(--color-text-muted)]">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-text-muted)]" />
        Checking
      </span>
    );
  }

  const state = status?.state || "setup_needed";
  const classes =
    state === "ready"
      ? "border-[var(--color-primary)]/20 bg-[var(--color-primary-light)] text-[var(--color-primary)]"
      : state === "not_connected"
        ? "border-[var(--color-border)] bg-white text-[var(--color-text-muted)]"
        : "border-[var(--color-accent)]/25 bg-[var(--color-accent-light)] text-[var(--color-accent-text)]";
  const dot =
    state === "ready"
      ? "bg-[var(--color-primary)]"
      : state === "not_connected"
        ? "bg-[var(--color-border)]"
        : "bg-[var(--color-accent)]";

  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${classes}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {status?.label || "Setup needed"}
    </span>
  );
}

function InlineWarning({ children }) {
  return (
    <div role="alert" className="mt-4 flex items-start gap-2.5 rounded-xl border border-[var(--color-accent)]/30 bg-[var(--color-accent-light)] px-3.5 py-3">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white text-[11px] font-bold text-[var(--color-accent-text)]">!</span>
      <p className="text-xs leading-5 text-[var(--color-text)]">{children}</p>
    </div>
  );
}

function Choice({ checked, label, description, onChange }) {
  return (
    <label className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors ${checked ? "border-[var(--color-primary)] bg-[var(--color-primary-light)]/55" : "border-[var(--color-border)] hover:bg-[var(--color-bg)]"}`}>
      <input type="radio" name="follow-up-trigger" checked={checked} onChange={onChange} className="sr-only" />
      <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${checked ? "border-[var(--color-primary)]" : "border-[var(--color-border)]"}`}>{checked && <span className="h-2 w-2 rounded-full bg-[var(--color-primary)]" />}</span>
      <span>
        <span className="block text-sm font-semibold">{label}</span>
        <span className="mt-1 block text-xs leading-5 text-[var(--color-text-muted)]">{description}</span>
      </span>
    </label>
  );
}

function OutcomeCard({ icon, iconClass, title, text }) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
      <span className={`flex h-9 w-9 items-center justify-center rounded-xl ${iconClass}`} aria-hidden="true">{icon}</span>
      <p className="mt-2 text-xs font-semibold">{title}</p>
      <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">{text}</p>
    </div>
  );
}

function ScoringField({ id, label, hint, value, min, max, suffix, onChange }) {
  return (
    <div>
      <label htmlFor={id} className="text-sm font-semibold">{label}</label>
      <div className="mt-2 flex items-center overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] focus-within:border-[var(--color-primary)] focus-within:ring-2 focus-within:ring-[var(--color-primary-light)]">
        <input id={id} type="number" min={min} max={max} step="1" value={value} onChange={(event) => onChange(event.target.value)} className="min-w-0 flex-1 bg-transparent px-3.5 py-2.5 text-sm outline-none" />
        <span className="border-l border-[var(--color-border)] px-3 py-2.5 text-xs text-[var(--color-text-muted)]">{suffix}</span>
      </div>
      <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">{hint}</p>
    </div>
  );
}

function Rule({ text }) {
  return (
    <li className="flex items-start gap-2.5">
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[var(--color-primary-light)] text-[var(--color-primary)]">✓</span>
      <p className="text-xs leading-5 text-[var(--color-text-muted)]">{text}</p>
    </li>
  );
}

function formatDelay(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return "not set";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${hours} hour${hours === 1 ? "" : "s"}${remainder ? ` ${remainder} min` : ""}`;
}

function IconBase({ children, ...props }) {
  return <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">{children}</svg>;
}
function ClockIcon(props) { return <IconBase {...props}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" /></IconBase>; }
function CommentIcon(props) { return <IconBase {...props}><path d="M4 5h16v11H9l-5 4V5Z" strokeLinecap="round" strokeLinejoin="round" /><path d="M8 9h8M8 12h5" strokeLinecap="round" /></IconBase>; }
function ChevronDownIcon(props) { return <IconBase {...props}><path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" /></IconBase>; }
function ScoreIcon(props) { return <IconBase {...props}><path d="M4 19V9M10 19V5M16 19v-7M22 19V8" strokeLinecap="round" /><path d="m3 7 6-4 6 7 6-4" strokeLinecap="round" strokeLinejoin="round" /></IconBase>; }
function DistributionIcon(props) { return <IconBase {...props}><circle cx="6" cy="6" r="2" /><circle cx="18" cy="6" r="2" /><circle cx="12" cy="18" r="2" /><path d="M7.7 7.1 10.8 16M16.3 7.1 13.2 16M8 6h8" strokeLinecap="round" /></IconBase>; }
function HotIcon(props) { return <IconBase {...props}><path d="M13 3c1 4-2 5-2 8 0 1.7 1.3 3 3 3 2.2 0 4-1.8 4-4 2 2.1 3 4.2 3 6.1A9 9 0 1 1 6.3 9.2C7 12 8.7 13 10 13c-1.5-4 1-6.8 3-10Z" strokeLinecap="round" strokeLinejoin="round" /></IconBase>; }
function ColdIcon(props) { return <IconBase {...props}><path d="M12 2v20M4.2 6.5l15.6 11M19.8 6.5l-15.6 11M8.5 4.5 12 7l3.5-2.5M8.5 19.5 12 17l3.5 2.5M3.5 10 7 12l-3.5 2M20.5 10 17 12l3.5 2" strokeLinecap="round" strokeLinejoin="round" /></IconBase>; }
function StaffIcon(props) { return <IconBase {...props}><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6" strokeLinecap="round" strokeLinejoin="round" /></IconBase>; }
