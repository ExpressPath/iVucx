From Stdlib Require Import String Ascii List.
From MetaRocq.Template Require Import All.
From MetaRocq.Common Require Import BasicAst Kernames Universes Environment.

Import MonadNotation.
Import ListNotations.
Local Open Scope bs_scope.
Local Infix "^" := String.append (at level 30, right associativity).

Definition ivucx_quote_char : Byte.byte := Byte.x22.
Definition ivucx_backslash_char : Byte.byte := Byte.x5c.
Definition ivucx_newline_char : Byte.byte := Byte.x0a.
Definition ivucx_return_char : Byte.byte := Byte.x0d.
Definition ivucx_tab_char : Byte.byte := Byte.x09.

Definition ivucx_char_string (ch : Byte.byte) : string :=
  String.String ch String.EmptyString.

Definition ivucx_quote_string : string := ivucx_char_string ivucx_quote_char.
Definition ivucx_backslash_string : string := ivucx_char_string ivucx_backslash_char.

Definition ivucx_json_null : string := "null".

Fixpoint ivucx_escape_json_string (value : string) : string :=
  match value with
  | String.EmptyString => String.EmptyString
  | String.String ch rest =>
      let escaped :=
        if Byte.eqb ch ivucx_quote_char then ivucx_backslash_string ^ ivucx_quote_string
        else if Byte.eqb ch ivucx_backslash_char then ivucx_backslash_string ^ ivucx_backslash_string
        else if Byte.eqb ch ivucx_newline_char then ivucx_backslash_string ^ "n"
        else if Byte.eqb ch ivucx_return_char then ivucx_backslash_string ^ "r"
        else if Byte.eqb ch ivucx_tab_char then ivucx_backslash_string ^ "t"
        else ivucx_char_string ch
      in
      escaped ^ ivucx_escape_json_string rest
  end.

Definition ivucx_json_string (value : string) : string :=
  ivucx_quote_string ^ ivucx_escape_json_string value ^ ivucx_quote_string.

Definition ivucx_json_bool (value : bool) : string :=
  if value then "true" else "false".

Fixpoint ivucx_join_with_comma (items : list string) : string :=
  match items with
  | [] => String.EmptyString
  | [item] => item
  | item :: rest => item ^ "," ^ ivucx_join_with_comma rest
  end.

Definition ivucx_json_array (items : list string) : string :=
  "[" ^ ivucx_join_with_comma items ^ "]".

Definition ivucx_json_field (key value : string) : string :=
  ivucx_json_string key ^ ":" ^ value.

Definition ivucx_json_object (fields : list string) : string :=
  "{" ^ ivucx_join_with_comma fields ^ "}".

Definition ivucx_json_raw_level (value : string) : string :=
  ivucx_json_object [
    ivucx_json_field "kind" (ivucx_json_string "raw-level");
    ivucx_json_field "value" (ivucx_json_string value)
  ].

Definition ivucx_json_name (na : name) : string :=
  ivucx_json_string (string_of_name na).

Definition ivucx_json_aname (na : aname) : string :=
  ivucx_json_object [
    ivucx_json_field "name" (ivucx_json_string (string_of_name (binder_name na)));
    ivucx_json_field "relevance" (ivucx_json_string (string_of_relevance (binder_relevance na)))
  ].

Definition ivucx_json_aname_array (items : list aname) : string :=
  ivucx_json_array (map ivucx_json_aname items).

Definition ivucx_json_instance (u : Instance.t) : string :=
  ivucx_json_array (map (fun level => ivucx_json_raw_level (string_of_level level)) u).

Definition ivucx_json_sort (s : Sort.t) : string :=
  ivucx_json_object [
    ivucx_json_field "kind" (ivucx_json_string "sort");
    ivucx_json_field "level" (ivucx_json_raw_level (string_of_sort s))
  ].

Definition ivucx_json_cast_kind (kind : cast_kind) : string :=
  ivucx_json_string (
    match kind with
    | VmCast => "VmCast"
    | NativeCast => "NativeCast"
    | Cast => "Cast"
    end
  ).

Definition ivucx_json_projection (proj : projection) : string :=
  ivucx_json_object [
    ivucx_json_field "inductive" (ivucx_json_string (string_of_inductive (proj_ind proj)));
    ivucx_json_field "npars" (string_of_nat (proj_npars proj));
    ivucx_json_field "arg" (string_of_nat (proj_arg proj))
  ].

Fixpoint ivucx_json_term (fuel : nat) (t : term) {struct fuel} : string :=
  match fuel with
  | O => "#IVUCX_CIC_DEPTH_LIMIT#"
  | S fuel' =>
  match t with
  | tRel n =>
      ivucx_json_object [
        ivucx_json_field "kind" (ivucx_json_string "rel");
        ivucx_json_field "index" (string_of_nat n)
      ]
  | tVar id =>
      ivucx_json_object [
        ivucx_json_field "kind" (ivucx_json_string "var");
        ivucx_json_field "name" (ivucx_json_string id)
      ]
  | tEvar ev args =>
      ivucx_json_object [
        ivucx_json_field "kind" (ivucx_json_string "evar");
        ivucx_json_field "index" (string_of_nat ev);
        ivucx_json_field "args" ("[" ^ ivucx_json_term_items fuel' args ^ "]")
      ]
  | tSort s =>
      ivucx_json_sort s
  | tCast tm kind ty =>
      ivucx_json_object [
        ivucx_json_field "kind" (ivucx_json_string "cast");
        ivucx_json_field "castKind" (ivucx_json_cast_kind kind);
        ivucx_json_field "term" (ivucx_json_term fuel' tm);
        ivucx_json_field "type" (ivucx_json_term fuel' ty)
      ]
  | tProd na ty body =>
      ivucx_json_object [
        ivucx_json_field "kind" (ivucx_json_string "prod");
        ivucx_json_field "name" (ivucx_json_name (binder_name na));
        ivucx_json_field "binderInfo" (ivucx_json_string "default");
        ivucx_json_field "relevance" (ivucx_json_string (string_of_relevance (binder_relevance na)));
        ivucx_json_field "type" (ivucx_json_term fuel' ty);
        ivucx_json_field "body" (ivucx_json_term fuel' body)
      ]
  | tLambda na ty body =>
      ivucx_json_object [
        ivucx_json_field "kind" (ivucx_json_string "lambda");
        ivucx_json_field "name" (ivucx_json_name (binder_name na));
        ivucx_json_field "binderInfo" (ivucx_json_string "default");
        ivucx_json_field "relevance" (ivucx_json_string (string_of_relevance (binder_relevance na)));
        ivucx_json_field "type" (ivucx_json_term fuel' ty);
        ivucx_json_field "body" (ivucx_json_term fuel' body)
      ]
  | tLetIn na def def_ty body =>
      ivucx_json_object [
        ivucx_json_field "kind" (ivucx_json_string "let");
        ivucx_json_field "name" (ivucx_json_name (binder_name na));
        ivucx_json_field "relevance" (ivucx_json_string (string_of_relevance (binder_relevance na)));
        ivucx_json_field "type" (ivucx_json_term fuel' def_ty);
        ivucx_json_field "value" (ivucx_json_term fuel' def);
        ivucx_json_field "body" (ivucx_json_term fuel' body);
        ivucx_json_field "nondep" (ivucx_json_bool false)
      ]
  | tApp f args =>
      ivucx_json_object [
        ivucx_json_field "kind" (ivucx_json_string "app");
        ivucx_json_field "fn" (ivucx_json_term fuel' f);
        ivucx_json_field "args" ("[" ^ ivucx_json_term_items fuel' args ^ "]")
      ]
  | tConst c u =>
      ivucx_json_object [
        ivucx_json_field "kind" (ivucx_json_string "const");
        ivucx_json_field "name" (ivucx_json_string (string_of_kername c));
        ivucx_json_field "universes" (ivucx_json_instance u)
      ]
  | tInd ind u =>
      ivucx_json_object [
        ivucx_json_field "kind" (ivucx_json_string "ind");
        ivucx_json_field "name" (ivucx_json_string (string_of_inductive ind));
        ivucx_json_field "universes" (ivucx_json_instance u)
      ]
  | tConstruct ind idx u =>
      ivucx_json_object [
        ivucx_json_field "kind" (ivucx_json_string "construct");
        ivucx_json_field "inductive" (ivucx_json_string (string_of_inductive ind));
        ivucx_json_field "ctorIndex" (string_of_nat idx);
        ivucx_json_field "universes" (ivucx_json_instance u)
      ]
  | tCase ci type_info discr branches =>
      ivucx_json_object [
        ivucx_json_field "kind" (ivucx_json_string "case");
        ivucx_json_field "inductive" (ivucx_json_string (string_of_inductive (ci_ind ci)));
        ivucx_json_field "caseInfo" (
          ivucx_json_object [
            ivucx_json_field "npars" (string_of_nat (ci_npar ci));
            ivucx_json_field "relevance" (ivucx_json_string (string_of_relevance (ci_relevance ci)))
          ]
        );
        ivucx_json_field "predicate" (
          ivucx_json_object [
            ivucx_json_field "universes" (ivucx_json_instance (puinst type_info));
            ivucx_json_field "params" ("[" ^ ivucx_json_term_items fuel' (pparams type_info) ^ "]");
            ivucx_json_field "context" (ivucx_json_aname_array (pcontext type_info));
            ivucx_json_field "returnType" (ivucx_json_term fuel' (preturn type_info))
          ]
        );
        ivucx_json_field "discriminant" (ivucx_json_term fuel' discr);
        ivucx_json_field "branches" ("[" ^ ivucx_json_branch_items fuel' branches ^ "]")
      ]
  | tProj proj tm =>
      ivucx_json_object [
        ivucx_json_field "kind" (ivucx_json_string "proj");
        ivucx_json_field "typeName" (ivucx_json_string (string_of_inductive (proj_ind proj)));
        ivucx_json_field "index" (string_of_nat (proj_arg proj));
        ivucx_json_field "projection" (ivucx_json_projection proj);
        ivucx_json_field "struct" (ivucx_json_term fuel' tm)
      ]
  | tFix defs idx =>
      ivucx_json_object [
        ivucx_json_field "kind" (ivucx_json_string "fix");
        ivucx_json_field "index" (string_of_nat idx);
        ivucx_json_field "definitions" ("[" ^ ivucx_json_def_items fuel' defs ^ "]")
      ]
  | tCoFix defs idx =>
      ivucx_json_object [
        ivucx_json_field "kind" (ivucx_json_string "cofix");
        ivucx_json_field "index" (string_of_nat idx);
        ivucx_json_field "definitions" ("[" ^ ivucx_json_def_items fuel' defs ^ "]")
      ]
  | tInt _ =>
      ivucx_json_object [
        ivucx_json_field "kind" (ivucx_json_string "lit");
        ivucx_json_field "literal" (ivucx_json_string "int");
        ivucx_json_field "value" ivucx_json_null
      ]
  | tFloat _ =>
      ivucx_json_object [
        ivucx_json_field "kind" (ivucx_json_string "lit");
        ivucx_json_field "literal" (ivucx_json_string "float");
        ivucx_json_field "value" ivucx_json_null
      ]
  | tString _ =>
      ivucx_json_object [
        ivucx_json_field "kind" (ivucx_json_string "lit");
        ivucx_json_field "literal" (ivucx_json_string "string");
        ivucx_json_field "value" ivucx_json_null
      ]
  | tArray u items default_value item_type =>
      ivucx_json_object [
        ivucx_json_field "kind" (ivucx_json_string "array");
        ivucx_json_field "universe" (ivucx_json_raw_level (string_of_level u));
        ivucx_json_field "elements" ("[" ^ ivucx_json_term_items fuel' items ^ "]");
        ivucx_json_field "default" (ivucx_json_term fuel' default_value);
        ivucx_json_field "type" (ivucx_json_term fuel' item_type)
      ]
  end
  end
with ivucx_json_term_items (fuel : nat) (items : list term) {struct fuel} : string :=
  match fuel with
  | O => "#IVUCX_CIC_DEPTH_LIMIT#"
  | S fuel' =>
  match items with
  | [] => String.EmptyString
  | [item] => ivucx_json_term fuel' item
  | item :: rest => ivucx_json_term fuel' item ^ "," ^ ivucx_json_term_items fuel' rest
  end
  end
with ivucx_json_branch_items (fuel : nat) (items : list (branch term)) {struct fuel} : string :=
  match fuel with
  | O => "#IVUCX_CIC_DEPTH_LIMIT#"
  | S fuel' =>
  match items with
  | [] => String.EmptyString
  | item :: rest =>
      let encoded := ivucx_json_object [
        ivucx_json_field "names" (ivucx_json_aname_array (bcontext item));
        ivucx_json_field "body" (ivucx_json_term fuel' (bbody item))
      ] in
      match rest with
      | [] => encoded
      | _ => encoded ^ "," ^ ivucx_json_branch_items fuel' rest
      end
  end
  end
with ivucx_json_def_items (fuel : nat) (items : list (def term)) {struct fuel} : string :=
  match fuel with
  | O => "#IVUCX_CIC_DEPTH_LIMIT#"
  | S fuel' =>
  match items with
  | [] => String.EmptyString
  | item :: rest =>
      let encoded := ivucx_json_object [
        ivucx_json_field "name" (ivucx_json_name (binder_name (dname item)));
        ivucx_json_field "relevance" (ivucx_json_string (string_of_relevance (binder_relevance (dname item))));
        ivucx_json_field "type" (ivucx_json_term fuel' (dtype item));
        ivucx_json_field "body" (ivucx_json_term fuel' (dbody item));
        ivucx_json_field "recursiveArg" (string_of_nat (rarg item))
      ] in
      match rest with
      | [] => encoded
      | _ => encoded ^ "," ^ ivucx_json_def_items fuel' rest
      end
  end
  end.

Definition ivucx_cic_fuel : nat := 10000.

Definition ivucx_json_constant_body (qualid_name : qualid) (body : constant_body) : string :=
  ivucx_json_object [
    ivucx_json_field "format" (ivucx_json_string "cic-v1");
    ivucx_json_field "theoremName" (ivucx_json_string qualid_name);
    ivucx_json_field "term" (
      match cst_body body with
      | Some term_body => ivucx_json_term ivucx_cic_fuel term_body
      | None => ivucx_json_null
      end
    );
    ivucx_json_field "context" (
      ivucx_json_object [
        ivucx_json_field "type" (ivucx_json_term ivucx_cic_fuel (cst_type body))
      ]
    );
    ivucx_json_field "declarations" ivucx_json_null;
    ivucx_json_field "metadata" (
      ivucx_json_object [
        ivucx_json_field "sourceLanguage" (ivucx_json_string "Coq");
        ivucx_json_field "extraction" (ivucx_json_string "metarocq-template");
        ivucx_json_field "relevance" (ivucx_json_string (string_of_relevance (cst_relevance body)));
        ivucx_json_field "hasBody" (ivucx_json_bool (
          match cst_body body with
          | Some _ => true
          | None => false
          end
        ));
        ivucx_json_field "universes" (
          match universes_entry_of_decl (cst_universes body) with
          | Monomorphic_entry _ => ivucx_json_string "monomorphic"
          | Polymorphic_entry _ => ivucx_json_string "polymorphic"
          end
        )
      ]
    )
  ].

Definition ivucx_export_constant (name : qualid) : TemplateMonad unit :=
  gr <- tmLocate1 name ;;
  match gr with
  | ConstRef kn =>
      body <- tmQuoteConstant kn true ;;
      tmMsg (ivucx_json_constant_body name body)
  | _ =>
      tmFail ("[" ^ name ^ "] is not a constant")
  end.

Redirect "__IVUCX_OUTPUT_PATH__" MetaRocq Run (ivucx_export_constant "__IVUCX_TARGET_QUALID__").
