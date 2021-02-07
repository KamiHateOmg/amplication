import React from "react";
import { gql, useQuery } from "@apollo/client";
import { useFormikContext } from "formik";
import { Link } from "react-router-dom";
import * as models from "../models";
import "./RelatedEntityFieldField.scss";

const CLASS_NAME = "related-entity-field-field";

const RelatedEntityFieldField = () => {
  const formik = useFormikContext<{
    id: string;
    properties: {
      relatedEntityId: string;
      relatedFieldId: string;
    };
  }>();

  const { data } = useQuery<{ entity: models.Entity }>(
    GET_ENTITY_FIELD_BY_PERMANENT_ID,
    {
      variables: {
        entityId: formik.values.properties.relatedEntityId,
        fieldPermanentId: formik.values.properties.relatedFieldId,
      },
    }
  );

  const relatedField =
    data &&
    data.entity &&
    data.entity.fields &&
    data.entity.fields.length &&
    data.entity.fields[0];

  return formik.values.properties.relatedFieldId
    ? (data && relatedField && (
        <div className={CLASS_NAME}>
          <label>Opposite Relation Field</label>

          <Link
            to={`/${data.entity.appId}/entities/${data.entity.id}/fields/${relatedField.id}`}
          >
            {relatedField.displayName}
          </Link>
        </div>
      )) ||
        null
    : "Can't find Opposite Relation Field";
};

export default RelatedEntityFieldField;

export const GET_ENTITY_FIELD_BY_PERMANENT_ID = gql`
  query GetEntityFieldByPermanentId(
    $entityId: String!
    $fieldPermanentId: String
  ) {
    entity(where: { id: $entityId }) {
      id
      appId
      fields(where: { permanentId: { equals: $fieldPermanentId } }) {
        id
        displayName
      }
    }
  }
`;
