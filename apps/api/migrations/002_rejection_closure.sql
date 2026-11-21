ALTER TABLE applications ADD COLUMN IF NOT EXISTS rejection_document_types text[] NOT NULL DEFAULT '{}';

-- Recover only document reasons supported by the recorded rejection and findings.
UPDATE applications a SET rejection_document_types = ARRAY(
  SELECT DISTINCT f.doc_type FROM validation_findings f
  WHERE f.application_id=a.id AND f.data_version=a.data_version
    AND NOT f.passed AND f.severity IN ('BLOCKING','REVIEW') AND f.doc_type IS NOT NULL
) WHERE a.status='REJECTED' AND a.rejection_reason_code='INVALID_DOCUMENTS' AND cardinality(a.rejection_document_types)=0;

WITH closed AS (
  UPDATE application_exceptions e SET status='RESOLVED',resolution='APPLICATION_REJECTED',
    resolved_at=now(),resolution_note='Closed because the application was rejected.'
  FROM applications a WHERE e.application_id=a.id AND a.status='REJECTED' AND e.status='OPEN'
  RETURNING e.id,e.application_id
)
INSERT INTO audit_events(application_id,event_type,actor_type,data)
SELECT application_id,'EXCEPTION_CLOSED','SYSTEM',jsonb_build_object('exception_id',id,'resolution','APPLICATION_REJECTED','migration',2) FROM closed;
UPDATE info_requests r SET status='CANCELLED' FROM applications a
WHERE r.application_id=a.id AND a.status='REJECTED' AND r.status='OPEN';
INSERT INTO schema_migrations(version) VALUES(2) ON CONFLICT DO NOTHING;
