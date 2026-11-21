// Derive display states without overwriting provider responses or validation history.
export function presentEvidence(
  documents: any[],
  findings: any[],
  exceptions: any[],
  checks: any[],
  application?: any,
) {
  for (const finding of findings) {
    const type = finding.rule_code === 'V-DOC-NAME' ? 'NAME_MISMATCH' : 'LOW_CONFIDENCE_EXTRACTION';
    const review = !finding.passed && finding.severity === 'REVIEW';
    const decisions = review
      ? exceptions.filter(
          (e) =>
            e.type === type &&
            e.details.doc_type === finding.doc_type &&
            e.details.field_name === finding.field_name &&
            e.status !== 'SUPERSEDED' &&
            new Date(e.raised_at).getTime() >= new Date(finding.created_at).getTime(),
        )
      : [];
    const resolved =
      decisions.length > 0 &&
      decisions.every(
        (e) => e.status === 'RESOLVED' && ['ACCEPTED', 'FALSE_POSITIVE'].includes(e.resolution),
      );
    finding.display_status = finding.passed
      ? 'PASSED'
      : resolved
        ? 'RESOLVED'
        : review
          ? 'IN_REVIEW'
          : finding.severity;
    finding.display_message = resolved
      ? `${finding.message} — accepted by reviewer.`
      : finding.message;
  }
  for (const doc of documents) {
    const related = findings.filter((f) => f.doc_type === doc.doc_type);
    const blocking = related.find((f) => !f.passed && f.severity === 'BLOCKING');
    const review = related.find((f) => f.display_status === 'IN_REVIEW');
    if (doc.extraction_status === 'COMPLETED' && doc.document_status !== 'NEEDS_INFO') {
      doc.document_status = !related.length
        ? 'PENDING_VALIDATION'
        : blocking
          ? 'NEEDS_INFO'
          : review
            ? 'IN_REVIEW'
            : 'COMPLETED';
      doc.status_message = !related.length
        ? 'Extraction completed. Document validation is pending.'
        : (blocking?.message ??
          review?.message ??
          (related.some((f) => f.display_status === 'RESOLVED')
            ? 'Document review accepted. Extraction and validation completed.'
            : 'Extraction and document validation completed.'));
    }
    for (const field of doc.fields) {
      const issues = related.filter(
        (f) => f.field_name === field.field_name && !f.passed && f.severity !== 'INFO',
      );
      field.display_status = !related.length
        ? 'PENDING'
        : issues.some((f) => f.severity === 'BLOCKING')
          ? 'CONFLICT'
          : issues.some((f) => f.display_status === 'IN_REVIEW')
            ? 'IN_REVIEW'
            : issues.some((f) => f.display_status === 'RESOLVED')
              ? 'RESOLVED'
              : field.validation;
    }
  }
  const slots: Record<string, string> = {
    PAN: 'PAN_CARD',
    GST: 'GST_CERTIFICATE',
    BANK: 'BANK_PROOF',
  };
  for (const check of checks) {
    const doc = documents.find((d) => d.doc_type === slots[check.check_type]);
    const review = exceptions.some(
      (e) => e.status === 'OPEN' && e.details.check_type === check.check_type,
    );
    check.display_status =
      check.input_current === false
        ? 'PENDING'
        : ['FAILED', 'TIMED_OUT', 'ERROR'].includes(check.status)
          ? check.status
          : doc &&
              [
                'FAILED',
                'NEEDS_INFO',
                'IN_REVIEW',
                'PENDING_VALIDATION',
                'PENDING',
                'EXTRACTING',
              ].includes(doc.document_status)
            ? doc.document_status
            : check.status === 'PASSED' && review
              ? 'IN_REVIEW'
              : check.status;
    check.display_message =
      check.input_current === false
        ? 'Details changed. A new API check is required.'
        : ['FAILED', 'TIMED_OUT', 'ERROR'].includes(check.status)
          ? 'Provider verification did not pass. See the attempt history.'
          : doc && doc.document_status !== 'COMPLETED'
            ? doc.status_message
            : check.display_status === 'IN_REVIEW'
              ? 'Provider result received; reviewer confirmation is still required.'
              : undefined;
  }
  if (application?.status === 'REJECTED') {
    const invalid = new Set<string>(application.rejection_document_types ?? []);
    const outstanding = [
      'IN_REVIEW',
      'PENDING',
      'PENDING_VALIDATION',
      'EXTRACTING',
      'NEEDS_INFO',
      'IN_PROGRESS',
    ];
    for (const exception of exceptions) {
      if (exception.resolution === 'APPLICATION_REJECTED' || exception.status === 'OPEN') {
        exception.status = 'CLOSED';
        exception.resolution = 'APPLICATION_REJECTED';
      }
    }
    for (const finding of findings) {
      if (
        !finding.passed &&
        (finding.display_status !== 'RESOLVED' || invalid.has(finding.doc_type)) &&
        finding.severity !== 'INFO'
      ) {
        finding.display_status = invalid.has(finding.doc_type)
          ? 'INVALID'
          : finding.doc_type
            ? 'REJECTED'
            : 'CLOSED';
        finding.display_message = `Recorded issue: ${finding.message} Closed with application rejection.`;
      }
    }
    for (const doc of documents) {
      if (invalid.has(doc.doc_type)) {
        doc.document_status = 'INVALID';
        doc.status_message = `Document rejected by the reviewer. ${application.decision_note ?? 'See the application rejection reason.'}`;
      } else if (['IN_REVIEW', 'NEEDS_INFO', 'FAILED'].includes(doc.document_status)) {
        const issue = findings.find(
          (f) => f.doc_type === doc.doc_type && !f.passed && f.severity !== 'INFO',
        );
        doc.document_status = 'REJECTED';
        doc.status_message = `Document review ended with application rejection.${issue ? ` Outstanding issue at rejection: ${issue.message}` : ''}`;
      } else if (outstanding.includes(doc.document_status)) {
        doc.document_status = 'CANCELLED';
        doc.status_message =
          'Document processing/review closed because the application was rejected.';
      }
      for (const field of doc.fields) {
        if (
          (invalid.has(doc.doc_type) &&
            findings.some(
              (f) =>
                f.doc_type === doc.doc_type &&
                f.field_name === field.field_name &&
                f.display_status === 'INVALID',
            )) ||
          outstanding.includes(field.display_status) ||
          ['CONFLICT', 'LOW_CONFIDENCE', 'UNREADABLE'].includes(field.display_status)
        )
          field.display_status = invalid.has(doc.doc_type)
            ? 'INVALID'
            : doc.document_status === 'REJECTED'
              ? 'REJECTED'
              : 'CLOSED';
      }
    }
    for (const check of checks) {
      if (invalid.has(slots[check.check_type])) {
        check.display_status = 'INVALID';
        check.display_message =
          'Associated document was rejected by the reviewer. The application is rejected.';
      } else if (
        documents.some(
          (d) => d.doc_type === slots[check.check_type] && d.document_status === 'REJECTED',
        )
      ) {
        check.display_status = 'REJECTED';
        check.display_message =
          'Document review ended with application rejection. See the recorded reason.';
      } else if (outstanding.includes(check.display_status)) {
        check.display_status = 'CANCELLED';
        check.display_message = 'Verification closed because the application was rejected.';
      }
    }
  }
}
