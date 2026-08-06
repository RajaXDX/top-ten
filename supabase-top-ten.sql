-- ============================================================================
--  توب تن — جداول الأونلاين
-- ============================================================================
--
--  يُشغَّل مرة واحدة في **نفس مشروع Supabase** الذي تستعمله «تحدي رجا»
--  (rqcltlleqpppeywxbkpo). كل ما هنا مسبوق بـ tt_ فلا يمسّ جداول رجا إطلاقاً.
--
--  ⚠️ شغّل كل دفعة وحدها في محرر SQL. المحرر ينفّذ اللصقة **كمعاملة واحدة**،
--     فخطأ في أمر واحد يُلغي كل شيء بصمت ولا تعرف أين وقع.
--
--  ↩️ للتراجع: آخر الملف دفعة تحذف كل ما أضافه هذا السكربت.
--
-- ============================================================================
--
--  لماذا لا يوجد تسجيل دخول؟
--  توب تن لعبة يفتحها اثنان في دقيقة — الحساب حاجز لا فائدة منه هنا. البديل:
--  كل جهاز يولّد `token` عشوائياً (uuid) ويحفظه في localStorage، والعضوية
--  تُثبت به. ولأن anon **ممنوع من الجدول تماماً**، لا يستطيع أحد قراءة
--  التوكنات ولا تعداد الرومات ولا الكتابة في روم ليس فيها — كل شيء يمرّ
--  بالدوال أدناه وهي تفحص التوكن قبل أي شيء.
--
-- ============================================================================


-- ======================== الدفعة 1: الجدول ========================

CREATE TABLE IF NOT EXISTS tt_rooms (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text UNIQUE NOT NULL,
  status      text NOT NULL DEFAULT 'waiting',   -- waiting | playing | ended
  -- اللاعبان داخل الصف نفسه: اثنان بحدّ أقصى، فجدول ثانٍ يضاعف الكود بلا مقابل
  players     jsonb NOT NULL DEFAULT '[]'::jsonb,
  state       jsonb,
  version     int  NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tt_rooms_code_idx    ON tt_rooms (code);
CREATE INDEX IF NOT EXISTS tt_rooms_created_idx ON tt_rooms (created_at);

ALTER TABLE tt_rooms ENABLE ROW LEVEL SECURITY;

-- ⚠️ **لا سياسة ولا صلاحية لأحد.** RLS مفعّلة بلا أي سياسة = لا أحد يصل
-- للجدول مباشرة. الدوال أدناه SECURITY DEFINER فتعمل بصلاحية مالكها.
REVOKE ALL ON tt_rooms FROM anon, authenticated;


-- ======================== الدفعة 2: أدوات داخلية ========================

-- كود من 6 خانات بلا حروف تلتبس بالنطق أو بالشكل (0/O و1/I محذوفة عمداً —
-- الكود يُقال بالصوت على الجوال، وحرف ملتبس يعني محاولة دخول فاشلة).
CREATE OR REPLACE FUNCTION tt_new_code() RETURNS text
LANGUAGE plpgsql AS $fn$
DECLARE
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  candidate text;
  i int;
BEGIN
  LOOP
    candidate := '';
    FOR i IN 1..6 LOOP
      candidate := candidate || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    END LOOP;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM tt_rooms WHERE code = candidate);
  END LOOP;
  RETURN candidate;
END;
$fn$;

-- الصورة التي تُعاد للمتصفح. ⚠️ **التوكنات تُنزع هنا** — لو سُرِّب توكن
-- الخصم لأمكن اللعب بدلاً عنه. المكان الوحيد الذي يخرج منه توكن هو ردّ
-- الإنشاء/الدخول لصاحبه وحده.
CREATE OR REPLACE FUNCTION tt_public_room(r tt_rooms) RETURNS jsonb
LANGUAGE sql STABLE AS $fn$
  SELECT jsonb_build_object(
    'code',    r.code,
    'status',  r.status,
    'state',   r.state,
    'version', r.version,
    'players', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'seat',   p->>'seat',
               'name',   p->>'name',
               'online', (COALESCE((p->>'seen')::timestamptz, r.created_at) > now() - interval '45 seconds')
             ) ORDER BY (p->>'seat')::int)
      FROM jsonb_array_elements(r.players) p
    ), '[]'::jsonb)
  );
$fn$;

-- مقعد صاحب التوكن في هذه الروم، أو NULL إن لم يكن عضواً
CREATE OR REPLACE FUNCTION tt_seat_of(r tt_rooms, p_token text) RETURNS int
LANGUAGE sql STABLE AS $fn$
  SELECT (p->>'seat')::int
  FROM jsonb_array_elements(r.players) p
  WHERE p->>'token' = p_token
  LIMIT 1;
$fn$;


-- ======================== الدفعة 3: الإنشاء والدخول ========================

CREATE OR REPLACE FUNCTION tt_create_room(p_name text, p_token text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  r tt_rooms;
BEGIN
  IF p_token IS NULL OR length(p_token) < 12 THEN
    RETURN jsonb_build_object('error', 'bad_token');
  END IF;

  -- تنظيف انتهازي: الرومات المهجورة تُحذف مع كل إنشاء، فلا نحتاج مهمة مجدولة
  DELETE FROM tt_rooms WHERE created_at < now() - interval '12 hours';

  INSERT INTO tt_rooms (code, players)
  VALUES (
    tt_new_code(),
    jsonb_build_array(jsonb_build_object(
      'seat', 0, 'name', left(COALESCE(NULLIF(btrim(p_name), ''), 'اللاعب الأول'), 20),
      'token', p_token, 'seen', now()
    ))
  )
  RETURNING * INTO r;

  RETURN tt_public_room(r) || jsonb_build_object('you', 0);
END;
$fn$;

CREATE OR REPLACE FUNCTION tt_join_room(p_code text, p_name text, p_token text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  r    tt_rooms;
  seat int;
BEGIN
  IF p_token IS NULL OR length(p_token) < 12 THEN
    RETURN jsonb_build_object('error', 'bad_token');
  END IF;

  -- ⚠️ القفل ضروري: لو دخل اثنان في نفس اللحظة لأخذا المقعد 1 كلاهما
  SELECT * INTO r FROM tt_rooms WHERE code = upper(btrim(p_code)) FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;

  seat := tt_seat_of(r, p_token);

  -- عائد بعد انقطاع أو تحديث صفحة: يستعيد مقعده واسمه ونقاطه كما هي
  IF seat IS NOT NULL THEN
    UPDATE tt_rooms SET
      players = (
        SELECT jsonb_agg(CASE WHEN p->>'token' = p_token
                              THEN p || jsonb_build_object('seen', now())
                              ELSE p END)
        FROM jsonb_array_elements(players) p
      ),
      updated_at = now()
    WHERE id = r.id RETURNING * INTO r;
    RETURN tt_public_room(r) || jsonb_build_object('you', seat);
  END IF;

  IF jsonb_array_length(r.players) >= 2 THEN
    RETURN jsonb_build_object('error', 'full');
  END IF;

  -- ⚠️ لا يدخل ثانٍ بعد بدء الجولة: القائمة نصفها مكشوف والنقاط جارية
  IF r.status <> 'waiting' THEN
    RETURN jsonb_build_object('error', 'started');
  END IF;

  UPDATE tt_rooms SET
    players = players || jsonb_build_array(jsonb_build_object(
      'seat', 1, 'name', left(COALESCE(NULLIF(btrim(p_name), ''), 'اللاعب الثاني'), 20),
      'token', p_token, 'seen', now()
    )),
    updated_at = now()
  WHERE id = r.id RETURNING * INTO r;

  RETURN tt_public_room(r) || jsonb_build_object('you', 1);
END;
$fn$;


-- ======================== الدفعة 4: الحالة والحضور ========================

-- تقرأ الروم وتُثبت حضورك في نداء واحد — وهي شبكة الأمان إن انقطع البثّ
CREATE OR REPLACE FUNCTION tt_snapshot(p_code text, p_token text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  r    tt_rooms;
  seat int;
BEGIN
  SELECT * INTO r FROM tt_rooms WHERE code = upper(btrim(p_code));
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;

  seat := tt_seat_of(r, p_token);
  IF seat IS NULL THEN RETURN jsonb_build_object('error', 'not_member'); END IF;

  UPDATE tt_rooms SET
    players = (
      SELECT jsonb_agg(CASE WHEN p->>'token' = p_token
                            THEN p || jsonb_build_object('seen', now())
                            ELSE p END)
      FROM jsonb_array_elements(players) p
    )
  WHERE id = r.id RETURNING * INTO r;

  RETURN tt_public_room(r) || jsonb_build_object('you', seat);
END;
$fn$;

-- ⚠️ **الكتابة لأي عضو، لا للمضيف وحده — مقصود.** صاحب الدور هو من يطبّق
-- إجابته ويبثّها، وهو ليس المضيف في نصف الأدوار. قصرها على المضيف يُجمّد
-- الدور عند الطرف الآخر (نفس عطل «تحدي رجا» البند 13).
-- الحارس الحقيقي هو `p_version`: من يكتب فوق نسخة أحدث يُرفض ويُعاد له
-- الأحدث بدل أن يمحوها.
CREATE OR REPLACE FUNCTION tt_push(p_code text, p_token text, p_state jsonb,
                                   p_status text, p_version int)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  r    tt_rooms;
  seat int;
BEGIN
  SELECT * INTO r FROM tt_rooms WHERE code = upper(btrim(p_code)) FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;

  seat := tt_seat_of(r, p_token);
  IF seat IS NULL THEN RETURN jsonb_build_object('error', 'not_member'); END IF;

  IF p_version <= r.version THEN
    RETURN tt_public_room(r) || jsonb_build_object('you', seat, 'stale', true);
  END IF;

  UPDATE tt_rooms SET
    state   = p_state,
    status  = COALESCE(NULLIF(p_status, ''), status),
    version = p_version,
    players = (
      SELECT jsonb_agg(CASE WHEN p->>'token' = p_token
                            THEN p || jsonb_build_object('seen', now())
                            ELSE p END)
      FROM jsonb_array_elements(players) p
    ),
    updated_at = now()
  WHERE id = r.id RETURNING * INTO r;

  RETURN tt_public_room(r) || jsonb_build_object('you', seat);
END;
$fn$;

CREATE OR REPLACE FUNCTION tt_leave(p_code text, p_token text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  r tt_rooms;
BEGIN
  SELECT * INTO r FROM tt_rooms WHERE code = upper(btrim(p_code)) FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', true); END IF;
  IF tt_seat_of(r, p_token) IS NULL THEN RETURN jsonb_build_object('ok', true); END IF;

  UPDATE tt_rooms SET
    players = COALESCE((
      SELECT jsonb_agg(p) FROM jsonb_array_elements(players) p
      WHERE p->>'token' <> p_token
    ), '[]'::jsonb),
    updated_at = now()
  WHERE id = r.id RETURNING * INTO r;

  -- آخر من يخرج يُطفئ النور
  IF jsonb_array_length(r.players) = 0 THEN
    DELETE FROM tt_rooms WHERE id = r.id;
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$fn$;


-- ======================== الدفعة 5: الصلاحيات ========================

REVOKE ALL ON FUNCTION tt_create_room(text, text)             FROM public;
REVOKE ALL ON FUNCTION tt_join_room(text, text, text)         FROM public;
REVOKE ALL ON FUNCTION tt_snapshot(text, text)                FROM public;
REVOKE ALL ON FUNCTION tt_push(text, text, jsonb, text, int)  FROM public;
REVOKE ALL ON FUNCTION tt_leave(text, text)                   FROM public;

GRANT EXECUTE ON FUNCTION tt_create_room(text, text)            TO anon, authenticated;
GRANT EXECUTE ON FUNCTION tt_join_room(text, text, text)        TO anon, authenticated;
GRANT EXECUTE ON FUNCTION tt_snapshot(text, text)               TO anon, authenticated;
GRANT EXECUTE ON FUNCTION tt_push(text, text, jsonb, text, int) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION tt_leave(text, text)                  TO anon, authenticated;

-- الدوال الداخلية لا تُنادى من المتصفح
REVOKE ALL ON FUNCTION tt_new_code()                 FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION tt_public_room(tt_rooms)      FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION tt_seat_of(tt_rooms, text)    FROM public, anon, authenticated;


-- ======================== الدفعة 6: التحقق ========================
-- المتوقّع: الجدول موجود، RLS مفعّلة، **صفر** سياسات، ولا صلاحية جدول لـ anon،
-- وخمس دوال قابلة للتنفيذ من anon.

SELECT relname, relrowsecurity AS rls,
       (SELECT count(*) FROM pg_policies WHERE tablename = 'tt_rooms') AS policies
FROM pg_class WHERE relname = 'tt_rooms';

SELECT grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_name = 'tt_rooms' AND grantee IN ('anon', 'authenticated');

SELECT p.proname, r.rolname AS granted_to
FROM pg_proc p
CROSS JOIN LATERAL (VALUES ('anon'), ('authenticated')) AS r(rolname)
WHERE p.proname LIKE 'tt\_%'
  AND has_function_privilege(r.rolname, p.oid, 'EXECUTE')
ORDER BY p.proname, r.rolname;


-- ============================================================================
-- ↩️ العودة (تحذف كل ما أضافه هذا الملف)
-- ============================================================================
-- DROP FUNCTION IF EXISTS tt_create_room(text, text);
-- DROP FUNCTION IF EXISTS tt_join_room(text, text, text);
-- DROP FUNCTION IF EXISTS tt_snapshot(text, text);
-- DROP FUNCTION IF EXISTS tt_push(text, text, jsonb, text, int);
-- DROP FUNCTION IF EXISTS tt_leave(text, text);
-- DROP FUNCTION IF EXISTS tt_public_room(tt_rooms);
-- DROP FUNCTION IF EXISTS tt_seat_of(tt_rooms, text);
-- DROP FUNCTION IF EXISTS tt_new_code();
-- DROP TABLE IF EXISTS tt_rooms;
